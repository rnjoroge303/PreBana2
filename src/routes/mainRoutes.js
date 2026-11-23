const express = require('express');
const adminController = require('../controllers/adminController');
const checkoutController = require('../controllers/checkoutController');
const receiptController = require('../controllers/receiptController');
const paymentController = require('../controllers/paymentController');
const productController = require('../controllers/productController');
const authController = require('../controllers/authController');
const { requireRole } = require('../middleware/auth');
const subRoutes = require('./subRoutes');
const router = express.Router()

router.get('/admin/login', authController.showAdminLogin);
router.post('/admin/login', authController.loginAdmin);
router.get('/admin/signup', requireRole('admin'), authController.showAdminSignup);
router.post('/admin/signup', requireRole('admin'), authController.signupAdmin);

router.get('/client/login', authController.showClientLogin);
router.post('/client/login', authController.loginClient);
router.get('/client/signup', authController.showClientSignup);
router.post('/client/signup', authController.signupClient);
router.post('/logout', authController.logout);

router.get('/checkout', requireRole('client'), checkoutController.showCheckout);
router.post('/checkout', requireRole('client'), checkoutController.placeOrder);
router.post('/orders/:id/mpesa', requireRole('client'), paymentController.initiateOrderPayment);
router.get('/orders/:id/payment-status', requireRole('client'), paymentController.getOrderPaymentStatus);
router.get('/orders/:id/receipt', requireRole('client'), async (req, res, next) => {
    try {
        const order = await checkoutController.getOrderById(req.params.id);
        if (!order || order.customer?.userId !== req.authUser.id) {
            return res.status(404).send('Order not found.');
        }
        if (order.paymentStatus !== 'paid') {
            return res.status(409).send('A receipt is available after payment is confirmed.');
        }
        return res.type('html').send(receiptController.buildThermalReceiptHtml(order));
    } catch (error) {
        return next(error);
    }
});
router.get('/orders/:id/receipt.pdf', requireRole('client'), async (req, res, next) => {
    try {
        const order = await checkoutController.getOrderById(req.params.id);
        if (!order || order.customer?.userId !== req.authUser.id) {
            return res.status(404).send('Order not found.');
        }
        if (order.paymentStatus !== 'paid') {
            return res.status(409).send('A receipt is available after payment is confirmed.');
        }
        const pdf = await receiptController.buildThermalReceiptPdf(order);
        const safeOrderId = String(order.id).replace(/[^a-zA-Z0-9_-]/g, '');
        return res
            .type('application/pdf')
            .attachment(`PreBana-receipt-${safeOrderId}.pdf`)
            .send(pdf);
    } catch (error) {
        return next(error);
    }
});
router.get('/orders', requireRole('client'), async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        return res.render('orders', {
            orders: await checkoutController.listCustomerOrders(req.authUser.id)
        });
    } catch (error) {
        return next(error);
    }
});
router.get('/orders/data', requireRole('client'), async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        return res.json({ orders: await checkoutController.listCustomerOrders(req.authUser.id) });
    } catch (error) {
        return next(error);
    }
});
router.delete('/orders/:id', requireRole('client'), async (req, res, next) => {
    try {
        const order = await checkoutController.deleteCustomerOrder(req.params.id, req.authUser.id);
        return res.json({ success: true, orderId: order.id });
    } catch (error) {
        if (error.message === 'Order not found or cannot be deleted.') {
            return res.status(404).json({ error: 'Order not found or it can no longer be deleted.' });
        }
        return next(error);
    }
});
router.post('/orders/:id/mpesa-confirmation', requireRole('client'), async (req, res, next) => {
    try {
        const order = await checkoutController.submitMpesaConfirmation(
            req.params.id,
            req.authUser.id,
            req.body?.paymentReference
        );
        return res.json({ success: true, order });
    } catch (error) {
        if (error.message === 'Order not found.') {
            return res.status(404).json({ error: 'Order not found.' });
        }
        if (
            error.message === 'This order is already marked as paid.'
            || error.message.startsWith('Enter a valid M-Pesa')
            || error.message.startsWith('We have not received a matching M-Pesa receipt')
            || error.message.startsWith('The M-Pesa receipt amount')
        ) {
            return res.status(400).json({ error: error.message });
        }
        return next(error);
    }
});
router.get('/store', requireRole('client'), productController.showStore);
router.get('/admin', requireRole('admin'), adminController.showDashboard);
router.get('/admin/orders/payment-status', requireRole('admin'), async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        const orders = await checkoutController.readOrders();
        return res.json({
            orders: orders.map((order) => ({
                id: order.id,
                paymentStatus: order.paymentStatus || 'pending',
                paymentReference: order.mpesa?.receipt || order.paymentReference || null,
                paymentResultDescription: order.paymentResultDescription || null
            }))
        });
    } catch (error) {
        return next(error);
    }
});
router.get('/admin/orders/:id/receipt', requireRole('admin'), async (req, res, next) => {
    try {
        const order = await checkoutController.getOrderById(req.params.id);
        if (!order) {
            return res.status(404).send('Order not found.');
        }
        return res.type('html').send(receiptController.buildThermalReceiptHtml(order, {
            pdfUrl: `/pre/admin/orders/${encodeURIComponent(order.id)}/receipt.pdf`,
            backUrl: '/pre/admin#accounts',
            backLabel: 'Back to customers'
        }));
    } catch (error) {
        return next(error);
    }
});
router.get('/admin/orders/:id/receipt.pdf', requireRole('admin'), async (req, res, next) => {
    try {
        const order = await checkoutController.getOrderById(req.params.id);
        if (!order) {
            return res.status(404).send('Order not found.');
        }
        const pdf = await receiptController.buildThermalReceiptPdf(order);
        const safeOrderId = String(order.id).replace(/[^a-zA-Z0-9_-]/g, '');
        return res
            .type('application/pdf')
            .attachment(`PreBana-receipt-${safeOrderId}.pdf`)
            .send(pdf);
    } catch (error) {
        return next(error);
    }
});
router.get('/admin/orders/:id/shipping-label', requireRole('admin'), async (req, res, next) => {
    try {
        const order = await checkoutController.getOrderById(req.params.id);
        if (!order) {
            return res.status(404).send('Order not found.');
        }
        return res.type('html').send(checkoutController.buildShippingLabelHtml(order));
    } catch (error) {
        return next(error);
    }
});
router.post('/admin/orders/:id/payment', requireRole('admin'), async (req, res, next) => {
    try {
        const paymentMethod = String(req.body?.paymentMethod || "Confirmed by admin").trim() || "Confirmed by admin";
        const order = await checkoutController.updateOrderPaymentStatus(req.params.id, 'paid', paymentMethod);
        return res.json({ success: true, order });
    } catch (error) {
        if (error.message === 'Order not found.') {
            return res.status(404).json({ error: 'Order not found.' });
        }
        return next(error);
    }
});
router.delete('/admin/orders/:id', requireRole('admin'), async (req, res, next) => {
    try {
        const order = await checkoutController.deleteOrder(req.params.id);
        return res.json({ success: true, orderId: order.id });
    } catch (error) {
        if (error.message === 'Order not found.') {
            return res.status(404).json({ error: 'Order not found.' });
        }
        return next(error);
    }
});
router.use('/admin', requireRole('admin'), subRoutes);


module.exports = router;