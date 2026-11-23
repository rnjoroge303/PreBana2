const assert = require("node:assert/strict");
const test = require("node:test");

function createPool() {
    let seeded = 1;
    const orders = new Map();

    async function execute(sql, parameters = []) {
        const query = sql.replace(/\s+/g, " ").trim();
        if (query.startsWith("INSERT IGNORE INTO prebana_order_store_lock")) {
            return [{ affectedRows: 0 }, []];
        }
        if (query.startsWith("SELECT seeded FROM prebana_order_store_lock")) {
            return [[{ seeded }], []];
        }
        if (query.startsWith("UPDATE prebana_order_store_lock")) {
            seeded = 1;
            return [{ affectedRows: 1 }, []];
        }
        if (query.startsWith("SELECT id FROM prebana_order_store_lock")) {
            return [[{ id: 1 }], []];
        }
        if (query.startsWith("SELECT payload FROM prebana_orders")) {
            const rows = [...orders.values()]
                .sort((left, right) => right.createdAt - left.createdAt)
                .map((row) => ({ payload: JSON.parse(row.payload) }));
            return [rows, []];
        }
        if (query.startsWith("DELETE FROM prebana_orders")) {
            const deleted = orders.size;
            orders.clear();
            return [{ affectedRows: deleted }, []];
        }
        if (query.includes("INTO prebana_orders")) {
            const [id, createdAt, payload] = parameters;
            if (query.startsWith("INSERT IGNORE") && orders.has(id)) {
                return [{ affectedRows: 0 }, []];
            }
            orders.set(id, { createdAt: new Date(createdAt), payload });
            return [{ affectedRows: 1 }, []];
        }
        return [[], []];
    }

    const connection = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        execute
    };

    return {
        query: execute,
        execute,
        getConnection: async () => connection,
        orders
    };
}

test("Vercel order storage persists create, update, and delete operations in MySQL", async () => {
    const databasePath = require.resolve("../src/db/db");
    const orderStorePath = require.resolve("../src/models/orderStore");
    const previousDatabaseModule = require.cache[databasePath];
    const previousOrderStoreModule = require.cache[orderStorePath];
    const previousVercelValue = process.env.VERCEL;
    const pool = createPool();

    process.env.VERCEL = "1";
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: pool
    };
    delete require.cache[orderStorePath];

    try {
        const orderStore = require(orderStorePath);
        const order = {
            id: "PB-TEST-ORDER",
            createdAt: "2026-11-24T00:00:00.000Z",
            paymentStatus: "pending",
            mpesa: { checkoutRequestId: "ws_CO_TEST" }
        };

        await orderStore.createOrder(order);
        assert.deepEqual(await orderStore.readOrders(), [order]);

        const updatedOrder = await orderStore.updateOrderByCheckoutRequest(
            "ws_CO_TEST",
            (entry) => {
                entry.paymentStatus = "paid";
                return entry;
            }
        );
        assert.equal(updatedOrder.paymentStatus, "paid");
        assert.equal((await orderStore.readOrders())[0].paymentStatus, "paid");

        await orderStore.deleteOrder(order.id);
        assert.deepEqual(await orderStore.readOrders(), []);
        assert.equal(pool.orders.size, 0);
    } finally {
        delete require.cache[orderStorePath];
        if (previousOrderStoreModule) {
            require.cache[orderStorePath] = previousOrderStoreModule;
        }
        if (previousDatabaseModule) {
            require.cache[databasePath] = previousDatabaseModule;
        } else {
            delete require.cache[databasePath];
        }
        if (previousVercelValue === undefined) {
            delete process.env.VERCEL;
        } else {
            process.env.VERCEL = previousVercelValue;
        }
    }
});
