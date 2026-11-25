const crypto = require("node:crypto");
const orderStore = require("../models/orderStore");
const productController = require("./productController");
const { formatPhoneNumber, initiateStkPush } = require("./stkPush");
const PDFDocument = require("pdfkit");

function normalizeItems(value){
    if (!Array.isArray(value) || value.length === 0 || value.length > 50){
        return null;
    }
    const quantities = new Map();
    for (const item of value){
        const productId = String(item?.productId || "").trim();
        const quantity = Number(item?.quantity);
        if (!productId || productId.length > 64 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99){
            return null;
        }
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
        if (quantities.get(productId) > 99){
            return null;
        }
    }
    return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

function createSaleId(){
    return `PB-POS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function createSaleOrder(req, saleItems, paymentMethod, phoneNumber){
    const now = new Date().toISOString();
    return {
        id: createSaleId(),
        customer: {
            name: String(req.body.customerName || "").trim() || "Walk-in customer",
            email: null,
            phone: String(req.body.customerPhone || "").trim(),
            address: ""
        },
        paymentPhone: phoneNumber || String(req.body.customerPhone || "").trim(),
        items: saleItems,
        total: saleItems.reduce((sum, item) => sum + item.lineTotal, 0),
        status: paymentMethod === "cash" ? "processing" : "received",
        paymentStatus: paymentMethod === "cash" ? "paid" : "pending",
        paymentMethod: paymentMethod === "cash" ? "Cash" : "M-Pesa STK Push",
        paymentConfirmedAt: paymentMethod === "cash" ? now : null,
        inventoryDeducted: paymentMethod === "cash",
        salesChannel: "physical",
        soldBy: {
            userId: req.authUser.id,
            email: req.authUser.email,
            role: req.authUser.role
        },
        createdAt: now
    };
}

async function createSale(req, res, next){
    try{
        const method = String(req.body?.paymentMethod || "").trim().toLowerCase();
        if (method !== "cash" && method !== "mpesa"){
            return res.status(400).json({ error: "Choose cash or M-Pesa as the payment method." });
        }
        const items = normalizeItems(req.body?.items);
        if (!items){
            return res.status(400).json({ error: "Add at least one valid product and quantity." });
        }
        const customerName = String(req.body?.customerName || "").trim();
        const customerPhone = String(req.body?.customerPhone || "").trim();
        if (customerName.length > 100){
            return res.status(400).json({ error: "Customer name must be 100 characters or fewer." });
        }
        if (customerPhone && !/^\+?[0-9][0-9\s()-]{6,19}$/.test(customerPhone)){
            return res.status(400).json({ error: "Enter a valid customer phone number." });
        }

        let phoneNumber = "";
        if (method === "mpesa"){
            const submittedPhone = String(req.body?.paymentPhone || customerPhone);
            try{
                phoneNumber = formatPhoneNumber(submittedPhone);
            } catch(error){
                return res.status(400).json({ error: error.message });
            }
        }

        const stockCheck = await productController.checkStock(items);
        if (stockCheck.error){
            return res.status(409).json({ error: stockCheck.error });
        }
        const order = createSaleOrder(req, stockCheck.itemsForOrder, method, phoneNumber);

        if (method === "cash"){
            const reserved = await productController.reserveStockForOrder(order.id, items);
            if (reserved.error){
                return res.status(409).json({ error: reserved.error });
            }
            order.items = reserved.itemsForOrder;
            order.total = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
            try{
                await orderStore.createOrder(order);
            } catch(error){
                try{
                    await productController.restoreStockForOrder(order.id, items);
                } catch(restoreError){
                    throw new AggregateError([error, restoreError], "The cash sale could not be saved and stock could not be restored.");
                }
                throw error;
            }
            return res.status(201).json({
                success: true,
                orderId: order.id,
                total: order.total,
                paymentStatus: "paid",
                receiptUrl: `/pre/admin/pos/sales/${encodeURIComponent(order.id)}/receipt`
            });
        }

        await orderStore.createOrder(order);
        try{
            const suffix = order.id.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
            const response = await initiateStkPush({
                phoneNumber,
                amount: order.total,
                accountReference: `POS${suffix}`,
                transactionDesc: "POS Sale"
            });
            if (String(response.ResponseCode) !== "0" || !response.CheckoutRequestID){
                const message = response.ResponseDescription || "M-Pesa did not accept the payment request.";
                await orderStore.updateOrder(order.id, (entry) => {
                    entry.paymentStatus = "failed";
                    entry.paymentResultDescription = message.slice(0, 255);
                    return entry;
                });
                return res.status(502).json({ error: message, orderId: order.id });
            }

            const updatedOrder = await orderStore.updateOrder(order.id, (entry) => {
                entry.mpesa = {
                    checkoutRequestId: response.CheckoutRequestID,
                    checkoutRequestIds: [response.CheckoutRequestID],
                    merchantRequestId: response.MerchantRequestID || null,
                    initiatedAt: new Date().toISOString(),
                    receipt: null,
                    amount: null
                };
                return entry;
            });
            if (!updatedOrder){
                throw new Error("The M-Pesa request was accepted but the sale could not be linked to it.");
            }
            return res.status(202).json({
                success: true,
                orderId: order.id,
                total: order.total,
                paymentStatus: "pending",
                customerMessage: response.CustomerMessage || "Complete the M-Pesa prompt on the customer's phone."
            });
        } catch(error){
            await orderStore.updateOrder(order.id, (entry) => {
                if (entry.paymentStatus !== "paid"){
                    entry.paymentStatus = "failed";
                    entry.paymentResultDescription = error.message.slice(0, 255);
                }
                return entry;
            });
            console.error("[POS] Could not start M-Pesa payment:", {
                orderId: order.id,
                error: error.message
            });
            const clientError = /valid Safaricom|configured|shortcode|passkey|callback URL|Buy Goods|alphanumeric|positive number|description must/i.test(error.message);
            return res.status(clientError ? 400 : 502).json({
                error: clientError ? error.message : "Could not start M-Pesa payment. Please try again.",
                orderId: order.id
            });
        }
    } catch(error){
        return next(error);
    }
}

async function getSalePaymentStatus(req, res, next){
    try{
        res.set("Cache-Control", "no-store");
        const order = await orderStore.readOrders().then((orders) =>
            orders.find((entry) => entry.id === String(req.params.id) && entry.salesChannel === "physical")
        );
        if (!order){
            return res.status(404).json({ error: "Sale not found." });
        }
        return res.json({
            orderId: order.id,
            paymentStatus: order.paymentStatus,
            paymentResultDescription: order.paymentResultDescription || null,
            receiptUrl: order.paymentStatus === "paid"
                ? `/pre/admin/pos/sales/${encodeURIComponent(order.id)}/receipt`
                : null
        });
    } catch(error){
        return next(error);
    }
}

function dateKeyInNairobi(value){
    const date = new Date(value);
    if (Number.isNaN(date.getTime())){
        return null;
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    return `${values.year}-${values.month}-${values.day}`;
}

function isValidDateKey(value){
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)){
        return false;
    }
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function paymentType(order){
    const method = String(order.paymentMethod || "").toLowerCase();
    if (method.includes("cash")){
        return "cash";
    }
    if (method.includes("mpesa") || method.includes("m-pesa")){
        return "mpesa";
    }
    return "other";
}

async function getDailySalesReport(req, res, next){
    try{
        const requestedDate = String(req.query.date || dateKeyInNairobi(new Date()));
        if (!isValidDateKey(requestedDate)){
            return res.status(400).json({ error: "Choose a valid report date." });
        }
        res.set("Cache-Control", "no-store");
        const orders = await orderStore.readOrders();
        const sales = orders
            .filter((order) => order.paymentStatus === "paid")
            .map((order) => {
                const paidAt = order.paymentConfirmedAt || order.createdAt;
                const channel = order.salesChannel === "physical" ? "physical" : "online";
                const payment = paymentType(order);
                return {
                    id: order.id,
                    paidAt,
                    channel,
                    payment,
                    amount: Number(order.total || 0),
                    itemCount: (Array.isArray(order.items) ? order.items : [])
                        .reduce((sum, item) => sum + Number(item.quantity || 0), 0),
                    soldBy: channel === "physical"
                        ? String(order.soldBy?.email || order.soldBy?.userId || "Unknown")
                        : "—"
                };
            })
            .filter((sale) => dateKeyInNairobi(sale.paidAt) === requestedDate)
            .sort((left, right) => String(right.paidAt).localeCompare(String(left.paidAt)));

        const summary = {
            transactionCount: sales.length,
            revenue: 0,
            online: { transactionCount: 0, revenue: 0 },
            physical: {
                transactionCount: 0,
                revenue: 0,
                cash: { transactionCount: 0, revenue: 0 },
                mpesa: { transactionCount: 0, revenue: 0 },
                other: { transactionCount: 0, revenue: 0 }
            }
        };
        const sellers = new Map();
        for (const sale of sales){
            summary.revenue += sale.amount;
            const channelSummary = summary[sale.channel];
            channelSummary.transactionCount += 1;
            channelSummary.revenue += sale.amount;
            if (sale.channel === "physical"){
                const paymentSummary = channelSummary[sale.payment] || channelSummary.other;
                paymentSummary.transactionCount += 1;
                paymentSummary.revenue += sale.amount;
                const seller = sellers.get(sale.soldBy) || {
                    seller: sale.soldBy,
                    transactionCount: 0,
                    revenue: 0
                };
                seller.transactionCount += 1;
                seller.revenue += sale.amount;
                sellers.set(sale.soldBy, seller);
            }
        }
        return res.json({
            date: requestedDate,
            timezone: "Africa/Nairobi",
            summary,
            sellers: [...sellers.values()].sort((left, right) => right.revenue - left.revenue),
            sales
        });
    } catch(error){
        return next(error);
    }
}

function cleanPdfText(value){
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\x20-\x7E]/g, "?");
}

async function downloadDailySalesReportPdf(req, res, next){
    try{
        const requestedDate = String(req.query.date || dateKeyInNairobi(new Date()));
        if (!isValidDateKey(requestedDate)){
            return res.status(400).json({ error: "Choose a valid report date." });
        }
        const orders = await orderStore.readOrders();
        const sales = orders
            .filter((order) => order.paymentStatus === "paid")
            .map((order) => ({
                id: order.id,
                paidAt: order.paymentConfirmedAt || order.createdAt,
                channel: order.salesChannel === "physical" ? "physical" : "online",
                payment: paymentType(order),
                amount: Number(order.total || 0),
                soldBy: order.salesChannel === "physical"
                    ? String(order.soldBy?.email || order.soldBy?.userId || "Unknown")
                    : "—"
            }))
            .filter((sale) => dateKeyInNairobi(sale.paidAt) === requestedDate)
            .sort((left, right) => String(right.paidAt).localeCompare(String(left.paidAt)));

        const summary = sales.reduce((totals, sale) => {
            totals.revenue += sale.amount;
            totals[sale.channel].count += 1;
            totals[sale.channel].revenue += sale.amount;
            if (sale.channel === "physical"){
                totals.physical[sale.payment].count += 1;
                totals.physical[sale.payment].revenue += sale.amount;
            }
            return totals;
        }, {
            revenue: 0,
            online: { count: 0, revenue: 0 },
            physical: {
                count: 0,
                revenue: 0,
                cash: { count: 0, revenue: 0 },
                mpesa: { count: 0, revenue: 0 },
                other: { count: 0, revenue: 0 }
            }
        });

        const document = new PDFDocument({ size: "A4", margin: 42, info: {
            Title: `PreBana Daily Sales Report - ${requestedDate}`,
            Subject: "Confirmed sales report",
            Author: "PreBana Cosmetics"
        }});
        const chunks = [];
        document.on("data", (chunk) => chunks.push(chunk));
        await new Promise((resolve, reject) => {
            document.on("error", reject);
            document.on("end", () => {
                const pdf = Buffer.concat(chunks);
                res
                    .type("application/pdf")
                    .attachment(`PreBana-Daily-Sales-Report-${requestedDate}.pdf`)
                    .send(pdf);
                resolve();
            });

            document.font("Helvetica-Bold").fontSize(18).fillColor("#17372f")
                .text("PREBANA COSMETICS", { align: "center"});
            document.moveDown(0.25);
            document.fontSize(13).text("DAILY SALES REPORT", { align: "center"});
            document.moveDown(0.35);
            document.font("Helvetica").fontSize(10).fillColor("#444444")
                .text(`Report date: ${requestedDate}`, { align: "center"});
            document.text("Timezone: Africa/Nairobi", { align: "center"});
            document.moveDown();

            document.font("Helvetica-Bold").fontSize(11).fillColor("#000000").text("SUMMARY");
            document.font("Helvetica").fontSize(10);
            document.text(`Confirmed transactions: ${sales.length}`);
            document.text(`Total revenue: KSh ${summary.revenue.toLocaleString("en-KE")}`);
            document.text(`Online: ${summary.online.count} transactions / KSh ${summary.online.revenue.toLocaleString("en-KE")}`);
            document.text(`Physical: ${summary.physical.count} transactions / KSh ${summary.physical.revenue.toLocaleString("en-KE")}`);
            document.text(`Physical Cash: ${summary.physical.cash.count} transactions / KSh ${summary.physical.cash.revenue.toLocaleString("en-KE")}`);
            document.text(`Physical M-Pesa: ${summary.physical.mpesa.count} transactions / KSh ${summary.physical.mpesa.revenue.toLocaleString("en-KE")}`);
            document.moveDown();

            document.font("Helvetica-Bold").fontSize(11).text("TRANSACTIONS");
            document.moveDown(0.25);
            if (!sales.length){
                document.font("Helvetica").fontSize(10).text("No paid sales for this date.");
            } else {
                for (const sale of sales){
                    const paidTime = new Date(sale.paidAt).toLocaleString("en-KE", {
                        timeZone: "Africa/Nairobi",
                        dateStyle: "short",
                        timeStyle: "short"
                    });
                    document.font("Helvetica").fontSize(9)
                        .text(`${cleanPdfText(paidTime)}  |  ${cleanPdfText(sale.id)}  |  ${sale.channel}  |  ${sale.payment}  |  KSh ${sale.amount.toLocaleString("en-KE")}  |  ${cleanPdfText(sale.soldBy)}`);
                }
            }
            document.end();
        });
    } catch(error){
        return next(error);
    }
}

module.exports = {
    createSale,
    getDailySalesReport,
    downloadDailySalesReportPdf,
    getSalePaymentStatus
};
