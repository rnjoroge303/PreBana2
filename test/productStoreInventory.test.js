const assert = require("node:assert/strict");
const test = require("node:test");

test("product storage makes inventory reserve and restore operations idempotent", async () => {
    const productStorePath = require.resolve("../src/models/productStore");
    const databasePath = require.resolve("../src/db/db");
    const previousModules = new Map([
        [productStorePath, require.cache[productStorePath]],
        [databasePath, require.cache[databasePath]]
    ]);
    const products = new Map([[
        "PB-TEST-1",
        {
            id: "PB-TEST-1",
            name: "Test lotion",
            category: "body",
            description: "Test product",
            price: 10,
            stock: 5,
            images: "[]",
            createdAt: new Date("2025-01-01T00:00:00.000Z"),
            updatedAt: null
        }
    ]]);
    const operations = new Map();

    async function execute(sql, parameters = []) {
        const query = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (query.startsWith("select seeded from prebana_product_store_lock")) {
            return [[{ seeded: 1 }]];
        }
        if (query.startsWith("select id from prebana_product_store_lock")) {
            return [[{ id: 1 }]];
        }
        if (query.startsWith("select id, name, category, description, price, stock, images")) {
            return [[...products.values()].map((product) => ({ ...product }))];
        }
        if (query.startsWith("select status from prebana_inventory_operations")) {
            const status = operations.get(parameters[0]);
            return [status ? [{ status }] : []];
        }
        if (query.startsWith("delete from prebana_products")) {
            products.clear();
            return [{ affectedRows: 1 }];
        }
        if (query.startsWith("insert ignore into prebana_products")) {
            const [id, name, category, description, price, stock, images, createdAt, updatedAt] = parameters;
            if (!products.has(id)) {
                products.set(id, { id, name, category, description, price, stock, images, createdAt, updatedAt });
            }
            return [{ affectedRows: 1 }];
        }
        if (query.startsWith("insert into prebana_inventory_operations")) {
            operations.set(parameters[0], "reserved");
            return [{ affectedRows: 1 }];
        }
        if (query.startsWith("update prebana_inventory_operations")) {
            operations.set(parameters[1], "restored");
            return [{ affectedRows: 1 }];
        }
        return [[], []];
    }

    const connection = {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async execute(sql, parameters) {
            return execute(sql, parameters);
        },
        release() {}
    };
    const pool = {
        async query() {
            return [[], []];
        },
        async execute(sql, parameters) {
            return execute(sql, parameters);
        },
        async getConnection() {
            return connection;
        }
    };

    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: pool
    };
    delete require.cache[productStorePath];

    try {
        const productStore = require(productStorePath);
        let changeCalls = 0;
        const reserve = (items) => {
            changeCalls += 1;
            items[0].stock -= 2;
            return {};
        };
        const restore = (items) => {
            changeCalls += 1;
            items[0].stock += 2;
            return {};
        };

        await productStore.changeProducts(reserve, { orderId: "order-1", action: "reserve" });
        const repeatedReserve = await productStore.changeProducts(reserve, { orderId: "order-1", action: "reserve" });
        assert.equal(repeatedReserve.alreadyApplied, true);
        assert.equal(changeCalls, 1);
        assert.equal((await productStore.readProducts())[0].stock, 3);

        await productStore.changeProducts(restore, { orderId: "order-1", action: "restore" });
        const repeatedRestore = await productStore.changeProducts(restore, { orderId: "order-1", action: "restore" });
        assert.equal(repeatedRestore.alreadyApplied, true);
        assert.equal(changeCalls, 2);
        assert.equal((await productStore.readProducts())[0].stock, 5);

        const reserveAfterRestore = await productStore.changeProducts(reserve, {
            orderId: "order-1",
            action: "reserve"
        });
        assert.match(reserveAfterRestore.error, /already been returned/);
        assert.equal(changeCalls, 2);
        assert.equal((await productStore.readProducts())[0].stock, 5);
    } finally {
        delete require.cache[productStorePath];
        delete require.cache[databasePath];
        for (const [modulePath, cachedModule] of previousModules) {
            if (cachedModule) {
                require.cache[modulePath] = cachedModule;
            }
        }
    }
});
