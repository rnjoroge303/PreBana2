const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ordersFile = path.join(__dirname, "..", "data", "orders.json");
let orderWriteQueue = Promise.resolve();
let databaseInitialization;

function usesVercelStorage() {
    return process.env.VERCEL === "1";
}

function getPool() {
    return require("../db/db");
}

function toMysqlDate(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function readBundledOrders() {
    try {
        const contents = await fs.readFile(ordersFile, "utf8");
        const data = JSON.parse(contents);
        return Array.isArray(data.orders) ? data.orders : [];
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function insertDatabaseOrders(executor, orders, ignoreDuplicates = false) {
    const insertVerb = ignoreDuplicates ? "INSERT IGNORE" : "INSERT";
    for (const order of orders) {
        await executor.execute(
            `${insertVerb} INTO prebana_orders (id, created_at, payload) VALUES (?, ?, ?)`,
            [order.id, toMysqlDate(order.createdAt), JSON.stringify(order)]
        );
    }
}

async function readDatabaseOrders(executor) {
    const [rows] = await executor.execute(
        "SELECT payload FROM prebana_orders ORDER BY created_at DESC, id DESC"
    );
    return rows.map((row) => typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload);
}

async function initializeDatabase() {
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_orders (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            created_at DATETIME(3) NOT NULL,
            payload JSON NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_order_store_lock (
            id TINYINT NOT NULL PRIMARY KEY,
            seeded TINYINT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB
    `);
    await pool.execute("INSERT IGNORE INTO prebana_order_store_lock (id, seeded) VALUES (1, 0)");

    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
        await connection.beginTransaction();
        transactionStarted = true;
        const [rows] = await connection.execute(
            "SELECT seeded FROM prebana_order_store_lock WHERE id = 1 FOR UPDATE"
        );
        if (!Number(rows[0]?.seeded)) {
            await insertDatabaseOrders(connection, await readBundledOrders(), true);
            await connection.execute("UPDATE prebana_order_store_lock SET seeded = 1 WHERE id = 1");
        }
        await connection.commit();
        transactionStarted = false;
    } catch (error) {
        if (transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Order storage initialization failed and its transaction could not be rolled back.");
            }
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function ensureDatabaseInitialized() {
    if (!databaseInitialization) {
        databaseInitialization = initializeDatabase().catch((error) => {
            databaseInitialization = null;
            throw error;
        });
    }
    await databaseInitialization;
}

async function changeDatabaseOrders(change) {
    await ensureDatabaseInitialized();
    const connection = await getPool().getConnection();
    let transactionStarted = false;
    try {
        await connection.beginTransaction();
        transactionStarted = true;
        await connection.execute("SELECT id FROM prebana_order_store_lock WHERE id = 1 FOR UPDATE");
        const orders = await readDatabaseOrders(connection);
        const result = await change(orders);
        if (!result.skipWrite) {
            await connection.execute("DELETE FROM prebana_orders");
            await insertDatabaseOrders(connection, orders);
        }
        await connection.commit();
        transactionStarted = false;
        return result.value;
    } catch (error) {
        if (transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Order change failed and its transaction could not be rolled back.");
            }
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function readOrders() {
    if (usesVercelStorage()) {
        await ensureDatabaseInitialized();
        return readDatabaseOrders(getPool());
    }
    try {
        const contents = await fs.readFile(ordersFile, "utf8");
        const data = JSON.parse(contents);
        return Array.isArray(data.orders) ? data.orders : [];
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function writeOrders(orders) {
    await fs.mkdir(path.dirname(ordersFile), { recursive: true });
    const temporaryFile = `${ordersFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ orders }, null, 2), "utf8");
    await fs.rename(temporaryFile, ordersFile);
}

function changeOrders(change) {
    if (usesVercelStorage()) {
        return changeDatabaseOrders(change);
    }
    const operation = orderWriteQueue.then(async () => {
        const orders = await readOrders();
        const result = await change(orders);
        if (!result.skipWrite) {
            await writeOrders(orders);
        }
        return result.value;
    });
    orderWriteQueue = operation.catch(() => { });
    return operation;
}

function createOrder(order) {
    return changeOrders((orders) => {
        orders.unshift(order);
        return { value: order };
    });
}

function updateOrder(orderId, change) {
    return changeOrders(async (orders) => {
        const order = orders.find((entry) => entry.id === String(orderId));
        if (!order) {
            return { value: null, skipWrite: true };
        }
        const updatedOrder = await change(order);
        if (!updatedOrder) {
            return { value: null, skipWrite: true };
        }
        return { value: updatedOrder };
    });
}

function updateOrderByCheckoutRequest(checkoutRequestId, change) {
    return changeOrders(async (orders) => {
        const requestId = String(checkoutRequestId);
        const order = orders.find((entry) => entry.mpesa?.checkoutRequestId === requestId
            || entry.mpesa?.checkoutRequestIds?.includes(requestId));
        if (!order) {
            return { value: null, skipWrite: true };
        }
        return { value: await change(order) || order };
    });
}

function deleteOrder(orderId, canDelete = () => true) {
    return changeOrders((orders) => {
        const index = orders.findIndex((entry) => entry.id === String(orderId));
        if (index < 0 || !canDelete(orders[index])) {
            return { value: null, skipWrite: true };
        }
        const [order] = orders.splice(index, 1);
        return { value: order };
    });
}

function restoreOrder(order) {
    return changeOrders((orders) => {
        if (!orders.some((entry) => entry.id === order.id)) {
            orders.unshift(order);
        }
        return { value: order };
    });
}

module.exports = {
    createOrder,
    deleteOrder,
    readOrders,
    restoreOrder,
    updateOrder,
    updateOrderByCheckoutRequest
};
