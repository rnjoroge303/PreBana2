const assert = require("node:assert/strict");
const test = require("node:test");

test("checkout keeps stock unchanged until payment is confirmed and deducts once", async () => {
    const checkoutPath = require.resolve("../src/controllers/checkoutController");
    const productPath = require.resolve("../src/controllers/productController");
    const orderStorePath = require.resolve("../src/models/orderStore");
    const previousModules = new Map([
        [checkoutPath, require.cache[checkoutPath]],
        [productPath, require.cache[productPath]],
        [orderStorePath, require.cache[orderStorePath]]
    ]);
    const products = [{ id: "PB-TEST-1", name: "Test lotion", price: 10, stock: 5 }];
    const orders = new Map();
    const inventoryOperations = new Map();
    const productController = {
        async checkStock(items) {
            const product = products.find((entry) => entry.id === items[0].productId);
            if (!product || items[0].quantity > product.stock) {
                return { error: "Not enough stock." };
            }
            return {
                itemsForOrder: [{
                    productId: product.id,
                    name: product.name,
                    quantity: items[0].quantity,
                    unitPrice: product.price,
                    lineTotal: product.price * items[0].quantity
                }]
            };
        },
        async reserveStockForOrder(orderId, items) {
            if (inventoryOperations.get(orderId) === "reserved") {
                return { alreadyApplied: true };
            }
            const product = products.find((entry) => entry.id === items[0].productId);
            if (!product || items[0].quantity > product.stock) {
                return { error: "Not enough stock." };
            }
            product.stock -= items[0].quantity;
            inventoryOperations.set(orderId, "reserved");
            return { itemsForOrder: [] };
        },
        async restoreStockForOrder(orderId, items) {
            if (inventoryOperations.get(orderId) !== "reserved") {
                return { alreadyApplied: true };
            }
            const product = products.find((entry) => entry.id === items[0].productId);
            product.stock += items[0].quantity;
            inventoryOperations.set(orderId, "restored");
            return {};
        }
    };
    const orderStore = {
        async createOrder(order) {
            orders.set(order.id, order);
            return order;
        },
        async updateOrder(orderId, change) {
            const order = orders.get(String(orderId));
            if (!order) {
                return null;
            }
            return await change(order);
        },
        async updateOrderByCheckoutRequest(checkoutRequestId, change) {
            const order = [...orders.values()].find((entry) =>
                entry.mpesa?.checkoutRequestId === String(checkoutRequestId)
                || entry.mpesa?.checkoutRequestIds?.includes(String(checkoutRequestId))
            );
            return order ? await change(order) || order : null;
        },
        async readOrders() {
            return [...orders.values()];
        }
    };
    require.cache[productPath] = {
        id: productPath,
        filename: productPath,
        loaded: true,
        exports: productController
    };
    require.cache[orderStorePath] = {
        id: orderStorePath,
        filename: orderStorePath,
        loaded: true,
        exports: orderStore
    };
    delete require.cache[checkoutPath];

    try {
        const checkoutController = require(checkoutPath);
        const response = {
            status(statusCode) {
                this.statusCode = statusCode;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            }
        };
        await checkoutController.placeOrder({
            body: {
                customerName: "Customer",
                phone: "+254712345678",
                paymentPhone: "+254712345678",
                address: "Nairobi",
                county: "Nairobi",
                items: [{ productId: "PB-TEST-1", quantity: 2 }]
            },
            authUser: { id: "client-1", email: "customer@example.com" }
        }, response, (error) => {
            throw error;
        });

        assert.equal(response.statusCode, 201);
        assert.equal(products[0].stock, 5);
        const order = orders.get(response.body.orderId);
        assert.equal(order.inventoryDeducted, false);

        await checkoutController.recordMpesaPush(order.id, "client-1", "254712345678", {
            CheckoutRequestID: "request-failed",
            MerchantRequestID: "merchant-failed"
        });
        await checkoutController.applyMpesaCallback("request-failed", {
            resultCode: 1032,
            resultDescription: "Cancelled",
            receipt: null,
            amount: null
        });
        assert.equal(products[0].stock, 5);

        await checkoutController.recordMpesaPush(order.id, "client-1", "254712345678", {
            CheckoutRequestID: "request-paid",
            MerchantRequestID: "merchant-paid"
        });
        const successfulCallback = {
            resultCode: 0,
            resultDescription: "Success",
            receipt: "ABC123",
            amount: order.total,
            payerName: "M-Pesa Payer"
        };
        await checkoutController.applyMpesaCallback("request-paid", successfulCallback);
        assert.equal(products[0].stock, 3);
        assert.equal(order.paymentStatus, "paid");
        assert.equal(order.inventoryDeducted, true);
        assert.equal(order.mpesa.payerName, "M-Pesa Payer");

        await checkoutController.applyMpesaCallback("request-paid", successfulCallback);
        assert.equal(products[0].stock, 3);
    } finally {
        delete require.cache[checkoutPath];
        delete require.cache[productPath];
        delete require.cache[orderStorePath];
        for (const [modulePath, cachedModule] of previousModules) {
            if (cachedModule) {
                require.cache[modulePath] = cachedModule;
            }
        }
    }
});
