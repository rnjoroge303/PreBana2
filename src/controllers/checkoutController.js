const crypto = require("node:crypto");
const productController = require("./productController");
const orderStore = require("../models/orderStore");

const { readOrders } = orderStore;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatCurrency(value) {
    return `KSh ${Number(value || 0).toLocaleString("en-KE")}`;
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "—";
    }
    return date.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
}

function buildReceiptHtml(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const rows = items.map((item) => `
        <tr>
            <td>${escapeHtml(item.name || "Product")}</td>
            <td>${Number(item.quantity || 0)}</td>
            <td>${formatCurrency(item.unitPrice || 0)}</td>
            <td>${formatCurrency(item.lineTotal || 0)}</td>
        </tr>`).join("");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PreBana Receipt - ${escapeHtml(order.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #172533; }
    .brand { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: #5f6b78; margin-bottom: 26px; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 18px 0 24px; }
    .meta div { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px 8px; text-align: left; }
    th { background: #f8fafc; }
    .total { text-align: right; font-weight: 700; font-size: 18px; margin-top: 16px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <div class="brand">PreBana Cosmetics</div>
  <div class="subtitle">Customer receipt</div>
  <div class="meta">
    <div><strong>Order ID:</strong><br>${escapeHtml(order.id)}</div>
    <div><strong>Ordered:</strong><br>${escapeHtml(formatDate(order.createdAt))}</div>
    <div><strong>Customer:</strong><br>${escapeHtml(order.customer?.name || "N/A")}</div>
    <div><strong>Phone:</strong><br>${escapeHtml(order.customer?.phone || "N/A")}</div>
  </div>
  <div><strong>Delivery address:</strong><br>${escapeHtml(order.customer?.address || "N/A")}</div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Qty</th>
        <th>Unit</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="4">No items listed.</td></tr>'}</tbody>
  </table>
  <div class="total">Total: ${formatCurrency(order.total || 0)}</div>
</body>
</html>`;
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

    const order = await orderStore.updateOrder(orderId, (entry) => {
        if (entry.customer?.userId !== userId) {
            return null;
        }
        if (entry.paymentStatus === "paid") {
            throw new Error("This order is already marked as paid.");
        }
        const savedReceipt = String(entry.mpesa?.receipt || "").trim().toUpperCase();
        if (!savedReceipt || savedReceipt !== reference || entry.paymentResultCode !== 0) {
            throw new Error("We have not received a matching M-Pesa receipt yet. Check the code and try again after Safaricom sends the payment confirmation.");
        }
        const receivedAmount = Number(entry.mpesa?.amount);
        if (!Number.isFinite(receivedAmount) || Math.round(receivedAmount) !== Math.round(Number(entry.total))) {
            throw new Error("The M-Pesa receipt amount does not match this order. Please contact the store.");
        }

        entry.paymentStatus = "paid";
        entry.paymentMethod = "M-Pesa STK Push";
        entry.paymentReference = savedReceipt;
        entry.status = "processing";
        entry.paymentConfirmedAt = new Date().toISOString();
        return entry;
    });
    if (!order) {
        throw new Error("Order not found.");
    }
    return order;
}

async function updateOrderPaymentStatus(orderId, paymentStatus = "paid", paymentMethod = "Confirmed by admin") {
    const order = await orderStore.updateOrder(orderId, (entry) => {
        entry.paymentStatus = paymentStatus;
        entry.paymentMethod = String(paymentMethod || "Confirmed by admin").trim() || "Confirmed by admin";
        if (paymentStatus === "paid") {
            entry.status = "processing";
            entry.paymentConfirmedAt = new Date().toISOString();
        }
        return entry;
    });
    if (!order) {
        throw new Error("Order not found.");
    }
    return order;
}

async function recordMpesaPush(orderId, userId, phoneNumber, response) {
    const order = await orderStore.updateOrder(orderId, (entry) => {
        if (entry.customer?.userId !== userId || entry.paymentStatus === "paid") {
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
    return orderStore.updateOrderByCheckoutRequest(checkoutRequestId, (order) => {
        if (order.paymentStatus === "paid") {
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
        let paymentStatus;
        if (successful) {
            paymentStatus = receipt && amountMatches ? "paid" : "review_required";
        } else {
            paymentStatus = callback.resultCode === 1032 ? "cancelled" : "failed";
        }

        order.paymentStatus = paymentStatus;
        order.paymentMethod = "M-Pesa STK Push";
        order.paymentResultCode = callback.resultCode;
        order.paymentResultDescription = String(callback.resultDescription || "").slice(0, 255);
        order.mpesa = {
            ...order.mpesa,
            receipt: receipt || null,
            amount: Number.isFinite(receivedAmount) ? receivedAmount : null,
            completedAt: new Date().toISOString()
        };
        if (paymentStatus === "paid") {
            order.paymentReference = receipt;
            order.status = "processing";
            order.paymentConfirmedAt = new Date().toISOString();
        }
        return order;
    });
}

async function removeOrder(orderId, canDelete) {
    const deletedOrder = await orderStore.deleteOrder(orderId, canDelete);
    if (!deletedOrder) {
        throw new Error(canDelete ? "Order not found or cannot be deleted." : "Order not found.");
    }
    try {
        await productController.restoreStock(
            (Array.isArray(deletedOrder.items) ? deletedOrder.items : [])
                .map((item) => ({ productId: item.productId, quantity: Number(item.quantity) || 0 }))
                .filter((item) => item.productId && item.quantity > 0)
        );
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
        const products = (await productController.readProducts())
            .filter((product) => Number(product.stock) > 0);
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

        const reservation = await productController.reserveStock(cart);
        if (reservation.error) {
            return res.status(409).json({ error: reservation.error });
        }
        const items = reservation.itemsForOrder;

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
            createdAt: new Date().toISOString()
        };

        try {
            await orderStore.createOrder(order);
        } catch (error) {
            await productController.restoreStock(cart);
            throw error;
        }
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
    buildReceiptHtml,
    buildShippingLabelHtml,
    showCheckout
};
