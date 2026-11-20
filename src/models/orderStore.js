const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ordersFile = path.join(__dirname, "..", "data", "orders.json");
let orderWriteQueue = Promise.resolve();

async function readOrders() {
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
    return changeOrders((orders) => {
        const order = orders.find((entry) => entry.id === String(orderId));
        if (!order) {
            return { value: null, skipWrite: true };
        }
        const updatedOrder = change(order);
        if (!updatedOrder) {
            return { value: null, skipWrite: true };
        }
        return { value: updatedOrder };
    });
}

function updateOrderByCheckoutRequest(checkoutRequestId, change) {
    return changeOrders((orders) => {
        const requestId = String(checkoutRequestId);
        const order = orders.find((entry) => entry.mpesa?.checkoutRequestId === requestId
            || entry.mpesa?.checkoutRequestIds?.includes(requestId));
        if (!order) {
            return { value: null, skipWrite: true };
        }
        return { value: change(order) || order };
    });
}

function deleteOrder(orderId) {
    return changeOrders((orders) => {
        const index = orders.findIndex((entry) => entry.id === String(orderId));
        if (index < 0) {
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
