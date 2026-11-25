const assert = require("node:assert/strict");
const test = require("node:test");

test("Vercel product storage migrates the catalog to public Blob and keeps inventory operations idempotent", async () => {
    const productStorePath = require.resolve("../src/models/productStore");
    const databasePath = require.resolve("../src/db/db");
    const blobPath = require.resolve("@vercel/blob");
    const previousModules = new Map([
        [productStorePath, require.cache[productStorePath]],
        [databasePath, require.cache[databasePath]],
        [blobPath, require.cache[blobPath]]
    ]);
    const previousVercelValue = process.env.VERCEL;
    const products = new Map([[
        "PB-TEST-1",
        {
            id: "PB-TEST-1",
            name: "Test lotion",
            category: "body",
            description: "Test product",
            price: 10,
            stock: 5,
            images: JSON.stringify([{ url: "/uploads/products/2f241c79-cc7e-4927-a171-56203cd04919.jpg", alt: "Test lotion" }]),
            createdAt: new Date("2025-01-01T00:00:00.000Z"),
            updatedAt: null
        }
    ]]);
    const operations = new Map();
    const writes = [];
    let catalog = null;
    let catalogPath = null;

    async function execute(sql, parameters = []) {
        const query = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (query.startsWith("insert ignore into prebana_product_store_lock")) {
            return [{ affectedRows: 0 }, []];
        }
        if (query.startsWith("select seeded from prebana_product_store_lock")) {
            return [[{ seeded: 1 }], []];
        }
        if (query.startsWith("update prebana_product_store_lock")) {
            return [{ affectedRows: 1 }, []];
        }
        if (query.startsWith("select id from prebana_product_store_lock")) {
            return [[{ id: 1 }], []];
        }
        if (query.startsWith("select blob_path as blobpath from prebana_product_catalog")) {
            return [catalogPath ? [{ blobPath: catalogPath }] : [], []];
        }
        if (query.startsWith("insert into prebana_product_catalog")) {
            catalogPath = parameters[0];
            return [{ affectedRows: 1 }, []];
        }
        if (query.startsWith("update prebana_product_catalog")) {
            catalogPath = parameters[0];
            return [{ affectedRows: 1 }, []];
        }
        if (query.startsWith("select id, name, category, description, price, stock, images")) {
            return [[...products.values()].map((product) => ({ ...product })), []];
        }
        if (query.startsWith("select order_id as orderid, status")) {
            return [[...operations].map(([orderId, status]) => ({ orderId, status })), []];
        }
        if (query.startsWith("select status from prebana_inventory_operations")) {
            const status = operations.get(parameters[0]);
            return [status ? [{ status }] : [], []];
        }
        if (query.startsWith("insert into prebana_inventory_operations")) {
            operations.set(parameters[0], parameters[1]);
            return [{ affectedRows: 1 }, []];
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
    const blobClient = {
        async get(pathname, options) {
            if (pathname === "catalog/products.json"){
                assert.equal(options.access === "private" || options.access === "public", true);
                if (options.access === "private"){
                    assert.equal(options.useCache, false);
                }
                return null;
            }
            assert.equal(pathname, catalogPath);
            assert.deepEqual(options, { access: "public" });
            return { statusCode: 200, stream: new Response(JSON.stringify(catalog)).body };
        },
        async put(pathname, body, options) {
            if (pathname.startsWith("products/catalog-")){
                assert.match(pathname, /^products\/catalog-[0-9a-f-]+\.json$/);
                assert.deepEqual(options, {
                    access: "public",
                    contentType: "application/json",
                    cacheControlMaxAge: 60
                });
                catalog = JSON.parse(body);
                catalogPath = pathname;
                writes.push({ pathname, options });
                return { pathname };
            } else {
                assert.match(pathname, /^products\/[0-9a-f-]+\.jpg$/);
                assert.deepEqual(options, { access: "public", contentType: "image/jpeg" });
                return { url: `https://blob.example/${pathname}` };
            }
        }
    };

    process.env.VERCEL = "1";
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: pool
    };
    require.cache[blobPath] = {
        id: blobPath,
        filename: blobPath,
        loaded: true,
        exports: blobClient
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

        assert.equal((await productStore.readProducts())[0].stock, 5);
        assert.equal(writes.length, 1);
        assert.equal(catalog.products[0].id, "PB-TEST-1");
        assert.equal(catalog.products[0].images[0].storage, "vercel-blob");
        assert.equal(catalog.products[0].images[0].url.startsWith("https://blob.example/products/"), true);
        assert.equal(Object.hasOwn(catalog, "inventoryOperations"), false);

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
        assert.equal(writes.every((write) => write.pathname.startsWith("products/catalog-")), true);
    } finally {
        delete require.cache[productStorePath];
        for (const [modulePath, cachedModule] of previousModules) {
            if (cachedModule) {
                require.cache[modulePath] = cachedModule;
            } else {
                delete require.cache[modulePath];
            }
        }
        if (previousVercelValue === undefined) {
            delete process.env.VERCEL;
        } else {
            process.env.VERCEL = previousVercelValue;
        }
    }
});
