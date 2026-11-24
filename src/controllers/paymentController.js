const checkoutController = require("./checkoutController");
const { formatPhoneNumber, initiateStkPush } = require("./stkPush");

function accountReference(orderId) {
    const suffix = String(orderId).replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
    return `ORD${suffix}`;
}

async function initiateOrderPayment(req, res) {
    const order = await checkoutController.getOrderById(req.params.id);
    if (!order || order.customer?.userId !== req.authUser.id) {
        return res.status(404).json({ error: "Order not found." });
    }
    if (order.paymentStatus === "paid" || (order.paymentResultCode === 0 && order.mpesa?.receipt)) {
        return res.status(409).json({ error: "Payment has already been confirmed for this order." });
    }

    try {
        const phoneNumber = formatPhoneNumber(req.body?.phoneNumber || order.paymentPhone || order.customer.phone);
        const orderReference = accountReference(order.id);
        console.info("[M-Pesa STK] Client payment requested", {
            orderId: order.id,
            userId: req.authUser.id,
            orderAmount: order.total,
            phoneNumber: `${phoneNumber.slice(0, 3)}******${phoneNumber.slice(-2)}`
        });
        const response = await initiateStkPush({
            phoneNumber,
            amount: order.total,
            accountReference: orderReference,
            transactionDesc: `Order No ${orderReference.slice(3)}`
        });
        if (String(response.ResponseCode) !== "0" || !response.CheckoutRequestID) {
            return res.status(502).json({ error: response.ResponseDescription || "M-Pesa did not accept the payment request." });
        }

        await checkoutController.recordMpesaPush(order.id, req.authUser.id, phoneNumber, response);
        console.info("[M-Pesa STK] Checkout request linked to order", {
            orderId: order.id,
            checkoutRequestId: response.CheckoutRequestID,
            merchantRequestId: response.MerchantRequestID || null
        });
        return res.status(202).json({
            success: true,
            orderId: order.id,
            checkoutRequestId: response.CheckoutRequestID,
            paymentStatus: "pending"
        });
    } catch (error) {
        console.error("[M-Pesa STK] Could not initiate order payment", {
            orderId: order.id,
            error: error.message
        });
        const clientError = /valid Safaricom|configured|shortcode|passkey|callback URL|Buy Goods|alphanumeric|positive number|description must/i.test(error.message);
        return res.status(clientError ? 400 : 502).json({
            error: clientError ? error.message : "Could not start M-Pesa payment. Please try again."
        });
    }
}

async function getOrderPaymentStatus(req, res) {
    res.set("Cache-Control", "no-store");
    const order = await checkoutController.getOrderById(req.params.id);
    if (!order || order.customer?.userId !== req.authUser.id) {
        return res.status(404).json({ error: "Order not found." });
    }
    return res.json({
        orderId: order.id,
        paymentStatus: order.paymentStatus,
        paymentReference: order.paymentReference || null,
        paymentResultDescription: order.paymentResultDescription || null
    });
}

module.exports = { accountReference, getOrderPaymentStatus, initiateOrderPayment };
