const assert = require("node:assert/strict");
const test = require("node:test");

function installPosDependencies(stkResponse = {}) {
    const posPath = require.resolve("../src/controllers/posController");
    const orderStorePath = require.resolve("../src/models/orderStore");
    const productControllerPath = require.resolve("../src/controllers/productController");
    const stkPushPath = require.resolve("../src/controllers/stkPush");
    const previousModules = new Map([
        [posPath, require.cache[posPath]],
        [orderStorePath, require.cache[orderStorePath]],
        [productControllerPath, require.cache[productControllerPath]],
        [stkPushPath, require.cache[stkPushPath]]
    ]);
    const orders = [];
    const inventory = [];
    let stkRequest;
    const products = new Map([
        ["PB-TEST-1", { id: "PB-TEST-1", name: "Test lotion", price: 250, stock: 8 }]
    ]);
    const productController = {
        async checkStock(items) {
            return { itemsForOrder: items.map((item) => {
                const product = products.get(item.productId);
                return {
                    productId: product.id,
                    name: product.name,
                    quantity: item.quantity,
                    unitPrice: product.price,
                    lineTotal: product.price * item.quantity
                };
            }) };
        },
        async reserveStockForOrder(orderId, items) {
            inventory.push({ orderId, items });
            return {
                itemsForOrder: items.map((item) => {
                    const product = products.get(item.productId);
                    return {
                        productId: product.id,
                        name: product.name,
                        quantity: item.quantity,
                        unitPrice: product.price,
                        lineTotal: product.price * item.quantity
                    };
                })
            };
        },
        async restoreStockForOrder() {}
    };
    const orderStore = {
        async createOrder(order) {
            orders.push(order);
            return order;
        },
        async updateOrder(orderId, change) {
            const order = orders.find((entry) => entry.id === String(orderId));
            return order ? await change(order) : null;
        },
        async readOrders() {
            return orders;
        }
    };
    const stkPush = {
        formatPhoneNumber(phone) {
            let digits = String(phone || "").replace(/\D/g, "");
            if (digits.startsWith("0")) digits = `254${digits.slice(1)}`;
            if (digits.startsWith("7") || digits.startsWith("1")) digits = `254${digits}`;
            if (!/^254[17]\d{8}$/.test(digits)) {
                throw new Error("Enter a valid Safaricom mobile number");
            }
            return digits;
        },
        async initiateStkPush(request) {
            stkRequest = request;
            return stkResponse;
        }
    };

    require.cache[orderStorePath] = { id: orderStorePath, filename: orderStorePath, loaded: true, exports: orderStore };
    require.cache[productControllerPath] = { id: productControllerPath, filename: productControllerPath, loaded: true, exports: productController };
    require.cache[stkPushPath] = { id: stkPushPath, filename: stkPushPath, loaded: true, exports: stkPush };
    delete require.cache[posPath];

    return {
        orders,
        inventory,
        getStkRequest: () => stkRequest,
        loadController: () => require(posPath),
        restore() {
            for (const [modulePath, cachedModule] of previousModules) {
                if (cachedModule) require.cache[modulePath] = cachedModule;
                else delete require.cache[modulePath];
            }
        }
    };
}

function createResponse() {
    return {
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        set(name, value) {
            this.headers = { ...(this.headers || {}), [name]: value };
            return this;
        },
        type(value) {
            this.headers = { ...(this.headers || {}), "Content-Type": value };
            return this;
        },
        attachment(filename) {
            this.headers = {
                ...(this.headers || {}),
                "Content-Disposition": `attachment; filename="${filename}"`
            };
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

function request(body, query = {}) {
    return {
        body,
        query,
        params: {},
        authUser: { id: "staff-id", email: "staff@example.com", role: "staff" }
    };
}

function nairobiDate(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date(value));
    const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    return `${fields.year}-${fields.month}-${fields.day}`;
}

test("POS cash sale records the seller and daily reports group online and physical sales", async () => {
    const dependencies = installPosDependencies();
    try {
        const controller = dependencies.loadController();
        const saleResponse = createResponse();
        await controller.createSale(request({
            items: [{ productId: "PB-TEST-1", quantity: 2 }],
            paymentMethod: "cash",
            customerName: "Walk-in"
        }), saleResponse, (error) => { throw error; });

        assert.equal(saleResponse.statusCode, 201);
        assert.equal(saleResponse.body.paymentStatus, "paid");
        assert.equal(dependencies.inventory.length, 1);
        assert.equal(dependencies.orders[0].salesChannel, "physical");
        assert.equal(dependencies.orders[0].paymentMethod, "Cash");
        assert.deepEqual(dependencies.orders[0].soldBy, {
            userId: "staff-id",
            email: "staff@example.com",
            role: "staff"
        });

        const now = new Date().toISOString();
        dependencies.orders.push(
            {
                id: "online-order",
                salesChannel: "online",
                paymentStatus: "paid",
                paymentMethod: "M-Pesa STK Push",
                total: 500,
                paymentConfirmedAt: now,
                createdAt: now,
                items: [{ quantity: 1 }]
            },
            {
                id: "physical-mpesa",
                salesChannel: "physical",
                paymentStatus: "paid",
                paymentMethod: "M-Pesa STK Push",
                total: 750,
                paymentConfirmedAt: now,
                soldBy: { email: "admin@example.com" },
                items: [{ quantity: 3 }]
            },
            {
                id: "unpaid-sale",
                salesChannel: "physical",
                paymentStatus: "pending",
                paymentMethod: "Cash",
                total: 999,
                createdAt: now
            }
        );
        const reportResponse = createResponse();
        await controller.getDailySalesReport(
            request(null, { date: nairobiDate(now) }),
            reportResponse,
            (error) => { throw error; }
        );

        assert.equal(reportResponse.body.summary.online.revenue, 500);
        assert.equal(reportResponse.body.summary.physical.cash.revenue, 500);
        assert.equal(reportResponse.body.summary.physical.mpesa.revenue, 750);
        assert.equal(reportResponse.body.summary.revenue, 1750);
        assert.equal(reportResponse.body.sellers.length, 2);
        assert.equal(reportResponse.body.sales.some((sale) => sale.id === "unpaid-sale"), false);
    } finally {
        dependencies.restore();
    }
});

test("POS M-Pesa sale sends an STK prompt and remains pending for callback confirmation", async () => {
    const dependencies = installPosDependencies({
        ResponseCode: "0",
        CheckoutRequestID: "ws_CO_POS_TEST",
        MerchantRequestID: "merchant-pos",
        CustomerMessage: "Enter PIN on the phone"
    });
    try {
        const controller = dependencies.loadController();
        const response = createResponse();
        await controller.createSale(request({
            items: [{ productId: "PB-TEST-1", quantity: 1 }],
            paymentMethod: "mpesa",
            paymentPhone: "0712345678"
        }), response, (error) => { throw error; });

        assert.equal(response.statusCode, 202);
        assert.equal(response.body.paymentStatus, "pending");
        assert.equal(dependencies.inventory.length, 0);
        assert.equal(dependencies.orders[0].paymentStatus, "pending");
        assert.equal(dependencies.orders[0].mpesa.checkoutRequestId, "ws_CO_POS_TEST");
        assert.equal(dependencies.orders[0].paymentPhone, "254712345678");
        assert.equal(dependencies.getStkRequest().amount, 250);
        assert.match(dependencies.getStkRequest().accountReference, /^POS[A-Z0-9]{4}$/);
    } finally {
        dependencies.restore();
    }
});

test("daily sales PDF download is labeled and contains PDF data", async () => {
    const dependencies = installPosDependencies();
    try {
        const controller = dependencies.loadController();
        const now = new Date().toISOString();
        dependencies.orders.push({
            id: "cash-sale-pdf",
            salesChannel: "physical",
            paymentStatus: "paid",
            paymentMethod: "Cash",
            total: 500,
            paymentConfirmedAt: now,
            soldBy: { email: "staff@example.com" },
            items: [{ quantity: 2 }]
        });
        const response = createResponse();
        await controller.downloadDailySalesReportPdf(
            request(null, { date: nairobiDate(now) }),
            response,
            (error) => { throw error; }
        );

        assert.ok(Buffer.isBuffer(response.body));
        assert.equal(response.body.subarray(0, 4).toString(), "%PDF");
        assert.match(response.headers["Content-Disposition"], /PreBana-Daily-Sales-Report-/);
    } finally {
        dependencies.restore();
    }
});
