const crypto = require("node:crypto");
const productController = require("./productController");
const orderStore = require("../models/orderStore");

const { readOrders } = orderStore;

function getOrderStockItems(order){
    return (Array.isArray(order.items) ? order.items : [])
        .map((item) => ({ productId: item.productId, quantity: Number(item.quantity) || 0 }))
        .filter((item) => item.productId && item.quantity > 0);
}

async function ensureOrderStockDeducted(order){
    if (order.inventoryDeducted !== false){
        return null;
    }

    const result = await productController.reserveStockForOrder(order.id, getOrderStockItems(order));
    if (result.error){
        return result.error;
    }
    return null;
}

async function restoreOrderStock(order){
    const items = getOrderStockItems(order);
    if (order.inventoryDeducted === undefined){
        return productController.restoreStock(items);
    }
    return productController.restoreStockForOrder(order.id, items);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildShippingLabelHtml(order) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PreBana Shipping Label - ${escapeHtml(order.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #172533; }
    .label { max-width: 700px; margin: 0 auto; border: 2px solid #dfe7eb; border-radius: 12px; padding: 24px; }
    .title { font-size: 28px; font-weight: 700; margin-bottom: 20px; }
    .row { display: flex; justify-content: space-between; gap: 32px; margin-bottom: 12px; }
    .meta { line-height: 1.8; }
    .box { margin-top: 20px; border-top: 1px dashed #cbd5e1; padding-top: 16px; }
    @media print { body { margin: 0; } .label { border: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="label">
    <div class="title">PreBana Shipping Label</div>
    <div class="row">
      <div class="meta">
        <div><strong>Order ID:</strong> ${escapeHtml(order.id)}</div>
        <div><strong>Customer:</strong> ${escapeHtml(order.customer?.name || "N/A")}</div>
        <div><strong>Phone:</strong> ${escapeHtml(order.customer?.phone || "N/A")}</div>
      </div>
      <div class="meta">
        <div><strong>Payment:</strong> ${escapeHtml(order.paymentStatus || "pending")}</div>
        <div><strong>Items:</strong> ${Number(Array.isArray(order.items) ? order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) : 0)}</div>
        <div><strong>Ship to:</strong> ${escapeHtml(order.customer?.address || "N/A")}</div>
      </div>
    </div>
    <div class="box">
      <strong>Order note:</strong> ${escapeHtml(order.note || "No additional note")}
    </div>
  </div>
</body>
</html>`;
}

async function getOrderById(orderId) {
    const orders = await readOrders();
    return orders.find((order) => order.id === String(orderId)) || null;
}

async function listCustomerOrders(userId) {
    const orders = await readOrders();
    return orders
        .filter((order) => order.customer?.userId === userId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function submitMpesaConfirmation(orderId, userId, paymentReference) {
    const reference = String(paymentReference || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(reference)) {
        throw new Error("Enter a valid M-Pesa transaction code (6–20 letters or numbers).");
    }

    const snapshot = await getOrderById(orderId);
    if (!snapshot || snapshot.customer?.userId !== userId) {
        throw new Error("Order not found.");
    }
    if (snapshot.paymentStatus === "paid") {
        throw new Error("This order is already marked as paid.");
    }
    const savedReceipt = String(snapshot.mpesa?.receipt || "").trim().toUpperCase();
    if (!savedReceipt || savedReceipt !== reference || snapshot.paymentResultCode !== 0) {
        throw new Error("We have not received a matching M-Pesa receipt yet. Check the code and try again after Safaricom sends the payment confirmation.");
    }
    const receivedAmount = Number(snapshot.mpesa?.amount);
    if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== Math.round(Number(snapshot.total))) {
        throw new Error("The M-Pesa receipt amount does not match this order. Please contact the store.");
    }

    const stockError = await ensureOrderStockDeducted(snapshot);
    const order = await orderStore.updateOrder(orderId, (entry) => {
        if (entry.customer?.userId !== userId) {
            return null;
        }
        if (entry.paymentStatus === "paid") {
            return entry;
        }
        const currentReceipt = String(entry.mpesa?.receipt || "").trim().toUpperCase();
        if (currentReceipt !== reference || entry.paymentResultCode !== 0) {
            return null;
        }
        entry.paymentMethod = "M-Pesa STK Push";
        entry.paymentReference = savedReceipt;
        entry.paymentConfirmedAt = new Date().toISOString();
        if (stockError){
            entry.paymentStatus = "review_required";
            entry.paymentResultDescription = `Payment was confirmed, but inventory needs review: ${stockError}`;
            return entry;
        }
        entry.inventoryDeducted = true;
        entry.paymentStatus = "paid";
        entry.status = "processing";
        return entry;
    });
    if (!order) {
        if (snapshot.inventoryDeducted === false && !stockError) {
            await productController.restoreStockForOrder(snapshot.id, getOrderStockItems(snapshot));
        }
        throw new Error("Order not found or payment details changed.");
    }
    return order;
}

async function updateOrderPaymentStatus(orderId, paymentStatus = "paid", paymentMethod = "Confirmed by admin") {
    const snapshot = await getOrderById(orderId);
    if (!snapshot) {
        throw new Error("Order not found.");
    }
    const stockError = paymentStatus === "paid"
        ? await ensureOrderStockDeducted(snapshot)
        : null;
    const order = await orderStore.updateOrder(orderId, (entry) => {
        entry.paymentMethod = String(paymentMethod || "Confirmed by admin").trim() || "Confirmed by admin";
        if (paymentStatus === "paid") {
            if (stockError){
                entry.paymentStatus = "review_required";
                entry.paymentResultDescription = `Payment was confirmed, but inventory needs review: ${stockError}`;
                return entry;
            }
            entry.inventoryDeducted = true;
            entry.paymentStatus = "paid";
            entry.status = "processing";
            entry.paymentConfirmedAt = new Date().toISOString();
        } else {
            entry.paymentStatus = paymentStatus;
        }
        return entry;
    });
    if (!order) {
        if (snapshot.inventoryDeducted === false && !stockError) {
            await productController.restoreStockForOrder(snapshot.id, getOrderStockItems(snapshot));
        }
        throw new Error("Order not found.");
    }
    return order;
}

async function recordMpesaPush(orderId, userId, phoneNumber, response) {
    const order = await orderStore.updateOrder(orderId, (entry) => {
        if (entry.customer?.userId !== userId
            || entry.paymentStatus === "paid"
            || (entry.paymentResultCode === 0 && entry.mpesa?.receipt)){
            return null;
        }
        entry.paymentStatus = "pending";
        entry.paymentMethod = "M-Pesa STK Push";
        entry.paymentPhone = phoneNumber;
        entry.mpesa = {
            ...entry.mpesa,
            checkoutRequestId: response.CheckoutRequestID,
            checkoutRequestIds: [...new Set([...(entry.mpesa?.checkoutRequestIds || []), response.CheckoutRequestID])].slice(-10),
            merchantRequestId: response.MerchantRequestID || null,
            initiatedAt: new Date().toISOString(),
            receipt: null,
            amount: null
        };
        delete entry.paymentReference;
        delete entry.paymentResultCode;
        delete entry.paymentResultDescription;
        return entry;
    });
    if (!order) {
        throw new Error("Order not found or payment is already complete.");
    }
    return order;
}

async function applyMpesaCallback(checkoutRequestId, callback) {
    const snapshot = await orderStore.updateOrderByCheckoutRequest(checkoutRequestId, (order) => {
        if (order.paymentStatus === "paid" || (order.paymentResultCode === 0 && order.mpesa?.receipt)){
            return order;
        }

        const successful = callback.resultCode === 0;
        const isCurrentAttempt = order.mpesa?.checkoutRequestId === String(checkoutRequestId);
        // A late cancellation from an older retry must not cancel the newest STK prompt.
        if (!successful && !isCurrentAttempt) {
            return order;
        }
        const receipt = String(callback.receipt || "").trim();
        const receivedAmount = Number(callback.amount);
        const amountMatches = Number.isFinite(receivedAmount)
            && Math.round(receivedAmount) === Math.round(Number(order.total));
        order.paymentStatus = successful
            ? receipt && amountMatches ? "pending" : "review_required"
            : callback.resultCode === 1032 ? "cancelled" : "failed";
        order.paymentMethod = "M-Pesa STK Push";
        order.paymentResultCode = callback.resultCode;
        order.paymentResultDescription = String(callback.resultDescription || "").slice(0, 255);
        order.mpesa = {
            ...order.mpesa,
            ...(typeof callback.payerName === "string" && callback.payerName.trim()
                ? { payerName: callback.payerName.trim().slice(0, 100) }
                : {}),
            receipt: receipt || null,
            amount: Number.isFinite(receivedAmount) ? receivedAmount : null,
            completedAt: new Date().toISOString()
        };
        if (successful && receipt && amountMatches) {
            order.paymentReference = receipt;
        } else {
            delete order.paymentReference;
        }
        return order;
    });
    if (!snapshot || snapshot.paymentStatus === "paid"){
        return snapshot;
    }

    const receipt = String(snapshot.mpesa?.receipt || "").trim();
    const receivedAmount = Number(snapshot.mpesa?.amount);
    const amountMatches = Number.isFinite(receivedAmount)
        && Math.round(receivedAmount) === Math.round(Number(snapshot.total));
    if (snapshot.paymentResultCode !== 0 || !receipt || !amountMatches){
        return snapshot;
    }

    const stockError = await ensureOrderStockDeducted(snapshot);
    const order = await orderStore.updateOrderByCheckoutRequest(checkoutRequestId, (entry) => {
        if (entry.paymentStatus === "paid"){
            return entry;
        }
        if (entry.paymentResultCode !== 0 || String(entry.mpesa?.receipt || "").trim() !== receipt){
            return entry;
        }
        entry.paymentReference = receipt;
        entry.paymentConfirmedAt = new Date().toISOString();
        if (stockError){
            entry.paymentStatus = "review_required";
            entry.paymentResultDescription = `Payment was confirmed, but inventory needs review: ${stockError}`;
            return entry;
        }
        entry.inventoryDeducted = true;
        entry.paymentStatus = "paid";
        entry.status = "processing";
        return entry;
    });
    if (!order && snapshot.inventoryDeducted === false && !stockError){
        await productController.restoreStockForOrder(snapshot.id, getOrderStockItems(snapshot));
    }
    return order;
}

async function removeOrder(orderId, canDelete) {
    const deletedOrder = await orderStore.deleteOrder(orderId, canDelete);
    if (!deletedOrder) {
        throw new Error(canDelete ? "Order not found or cannot be deleted." : "Order not found.");
    }
    try {
        await restoreOrderStock(deletedOrder);
    } catch (stockError) {
        try {
            await orderStore.restoreOrder(deletedOrder);
        } catch (restoreError) {
            throw new AggregateError([stockError, restoreError], "Stock restoration failed and the deleted order record could not be restored.");
        }
        throw stockError;
    }
    return deletedOrder;
}

async function deleteOrder(orderId) {
    return removeOrder(orderId);
}

async function deleteCustomerOrder(orderId, userId) {
    return removeOrder(orderId, (order) =>
        order.customer?.userId === userId && order.paymentStatus !== "paid"
    );
}

function normalizeCart(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
        return null;
    }
    const quantities = new Map();
    for (const item of items) {
        if (!item || typeof item !== "object") {
            return null;
        }
        const productId = String(item.productId || "").trim();
        const quantity = Number(item.quantity);
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            return null;
        }
        quantities.set(productId, (quantities.get(productId) || 0) + quantity);
        if (quantities.get(productId) > 99) {
            return null;
        }
    }
    return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

async function showCheckout(req, res, next) {
    try {
        const products = await productController.readProducts();
        res.render("checkout", {
            products,
            customerEmail: req.authUser.email
        });
    } catch (error) {
        next(error);
    }
}

async function placeOrder(req, res, next) {
    try {
        const customerName = String(req.body.customerName || "").trim();
        const phone = String(req.body.phone || "").trim();
        const paymentPhone = String(req.body.paymentPhone || phone).trim();
        const address = String(req.body.address || "").trim();
        const note = String(req.body.note || "").trim();
        const cart = normalizeCart(req.body.items);

        if (!customerName || customerName.length > 100) {
            return res.status(400).json({ error: "Enter your name (up to 100 characters)." });
        }
        if (!/^\+?[0-9][0-9\s()-]{6,19}$/.test(phone)) {
            return res.status(400).json({ error: "Enter a valid phone number." });
        }
        if (!/^\+?[0-9][0-9\s()-]{6,19}$/.test(paymentPhone)) {
            return res.status(400).json({ error: "Enter a valid M-Pesa paying phone number." });
        }
        if (!address || address.length > 300) {
            return res.status(400).json({ error: "Enter a delivery address (up to 300 characters)." });
        }
        if (note.length > 500) {
            return res.status(400).json({ error: "Order note must be 500 characters or fewer." });
        }
        if (!cart) {
            return res.status(400).json({ error: "Your bag is empty or contains invalid quantities." });
        }

        const stockCheck = await productController.checkStock(cart);
        if (stockCheck.error) {
            return res.status(409).json({ error: stockCheck.error });
        }
        const items = stockCheck.itemsForOrder;

        const order = {
            id: `PB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
            customer: {
                userId: req.authUser.id,
                name: customerName,
                email: req.authUser.email,
                phone,
                address
            },
            paymentPhone,
            items,
            total: items.reduce((sum, item) => sum + item.lineTotal, 0),
            note,
            status: "received",
            paymentStatus: "pending",
            paymentMethod: "pending confirmation",
            inventoryDeducted: false,
            createdAt: new Date().toISOString()
        };

        await orderStore.createOrder(order);
        return res.status(201).json({ orderId: order.id, total: order.total });
    } catch (error) {
        console.error("[Checkout] Could not place order:", error);
        return res.status(500).json({ error: "We couldn't save your order. Please try again." });
    }
}

async function listCustomers() {
    const orders = await readOrders();
    const customersById = new Map();
    for (const order of orders) {
        const key = order.customer.userId || order.customer.email;
        let customer = customersById.get(key);
        if (!customer) {
            customer = {
                id: key,
                name: order.customer.name,
                email: order.customer.email,
                phone: order.customer.phone,
                address: order.customer.address,
                orders: 0,
                totalSpent: 0,
                joinedAt: order.createdAt,
                lastOrderAt: order.createdAt
            };
            customersById.set(key, customer);
        }
        customer.orders += 1;
        customer.totalSpent += order.total;
        if (order.createdAt < customer.joinedAt) {
            customer.joinedAt = order.createdAt;
        }
        if (order.createdAt > customer.lastOrderAt) {
            customer.name = order.customer.name;
            customer.phone = order.customer.phone;
            customer.address = order.customer.address;
            customer.lastOrderAt = order.createdAt;
        }
    }
    return [...customersById.values()].sort((left, right) => right.lastOrderAt.localeCompare(left.lastOrderAt));
}

module.exports = {
    listCustomers,
    listCustomerOrders,
    placeOrder,
    readOrders,
    getOrderById,
    submitMpesaConfirmation,
    updateOrderPaymentStatus,
    recordMpesaPush,
    applyMpesaCallback,
    deleteOrder,
    deleteCustomerOrder,
    buildShippingLabelHtml,
    showCheckout
};
