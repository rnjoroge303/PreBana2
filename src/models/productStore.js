const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const bundledProductsFile = path.join(__dirname, "..", "data", "data.json");
const uploadDirectory = path.join(__dirname, "..", "..", "public", "uploads", "products");
const legacyCatalogBlobPath = "catalog/products.json";
const catalogBlobPrefix = "products/catalog-";
const imageContentTypes = new Map([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".avif", "image/avif"]
]);
let initialization;

function getPool(){
    return require("../db/db");
}

function getBlob(){
    return require("@vercel/blob");
}

function toMysqlDate(value){
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function fromDatabaseRow(row){
    const images = typeof row.images === "string" ? JSON.parse(row.images) : row.images;
    const product = {
        id: row.id,
        name: row.name,
        category: row.category,
        description: row.description,
        price: Number(row.price),
        stock: Number(row.stock),
        images: Array.isArray(images) ? images : [],
        createdAt: new Date(row.createdAt).toISOString()
    };
    if (row.updatedAt){
        product.updatedAt = new Date(row.updatedAt).toISOString();
    }
    return product;
}

function toDatabaseValues(product){
    return [
        product.id,
        product.name,
        product.category,
        product.description,
        Number(product.price),
        Number(product.stock),
        JSON.stringify(Array.isArray(product.images) ? product.images : []),
        toMysqlDate(product.createdAt),
        product.updatedAt ? toMysqlDate(product.updatedAt) : null
    ];
}

async function readBundledProducts(){
    try{
        const contents = await fs.readFile(bundledProductsFile, "utf8");
        const data = JSON.parse(contents);
        return Array.isArray(data) ? data : Array.isArray(data.products) ? data.products : [];
    } catch(error){
        if (error.code === "ENOENT"){
            return [];
        }
        throw error;
    }
}

async function insertProducts(connection, products){
    for (const product of products){
        await connection.execute(
            `INSERT IGNORE INTO prebana_products
                (id, name, category, description, price, stock, images, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            toDatabaseValues(product)
        );
    }
}

async function readDatabaseProducts(executor){
    const [rows] = await executor.execute(`
        SELECT id, name, category, description, price, stock, images,
               created_at AS createdAt, updated_at AS updatedAt
        FROM prebana_products
        ORDER BY created_at DESC
    `);
    return rows.map(fromDatabaseRow);
}

async function readDatabaseInventoryOperations(executor){
    const [rows] = await executor.execute(
        "SELECT order_id AS orderId, status FROM prebana_inventory_operations"
    );
    return rows;
}

async function readBlobCatalog(blobPath, access){
    const blob = await getBlob().get(blobPath, {
        access,
        ...(access === "private" ? { useCache: false } : {})
    });
    if (!blob){
        return null;
    }
    if (blob.statusCode !== 200 || !blob.stream){
        throw new Error("Vercel Blob returned an invalid product catalog response.");
    }
    const contents = await new Response(blob.stream).text();
    const data = JSON.parse(contents);
    return {
        products: Array.isArray(data.products) ? data.products : [],
        inventoryOperations: Array.isArray(data.inventoryOperations) ? data.inventoryOperations : []
    };
}

async function readCurrentBlobCatalog(executor){
    const [rows] = await executor.execute(
        "SELECT blob_path AS blobPath FROM prebana_product_catalog WHERE id = 1"
    );
    const blobPath = rows[0]?.blobPath;
    if (!blobPath){
        throw new Error("Vercel Blob product catalog location is missing.");
    }
    const catalog = await readBlobCatalog(blobPath, "public");
    if (!catalog){
        throw new Error("Vercel Blob product catalog is missing.");
    }
    return { blobPath, catalog };
}

async function writeBlobCatalog(products){
    const blob = await getBlob().put(
        `${catalogBlobPrefix}${crypto.randomUUID()}.json`,
        JSON.stringify({ products }),
        {
            access: "public",
            contentType: "application/json",
            cacheControlMaxAge: 60
        }
    );
    return blob.pathname;
}

async function persistInventoryOperations(connection, operations){
    for (const operation of operations){
        await connection.execute(
            `INSERT INTO prebana_inventory_operations (order_id, status, updated_at)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = VALUES(updated_at)`,
            [operation.orderId, operation.status, new Date()]
        );
    }
}

async function migrateLegacyProductImages(products){
    const { put } = getBlob();
    for (const product of products){
        if (!Array.isArray(product.images)){
            continue;
        }
        for (let index = 0; index < product.images.length; index += 1){
            const image = product.images[index];
            const url = typeof image === "string" ? image : image?.url;
            if (!url?.startsWith("/uploads/products/")){
                continue;
            }

            const filename = path.basename(url);
            const extension = path.extname(filename).toLowerCase();
            const contentType = imageContentTypes.get(extension);
            if (!contentType || url !== `/uploads/products/${filename}`){
                throw new Error(`Cannot migrate product image with unsupported path: ${url}`);
            }
            const contents = await fs.readFile(path.join(uploadDirectory, filename));
            const blob = await put(
                `products/${crypto.randomUUID()}${extension}`,
                contents,
                { access: "public", contentType }
            );
            product.images[index] = {
                ...(typeof image === "object" && image ? image : {}),
                url: blob.url,
                alt: typeof image === "object" && image?.alt ? image.alt : product.name,
                storage: "vercel-blob"
            };
        }
    }
}

async function initialize(){
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_products (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            category VARCHAR(16) NOT NULL,
            description VARCHAR(240) NOT NULL,
            price DECIMAL(12, 2) NOT NULL,
            stock INT NOT NULL,
            images JSON NOT NULL,
            created_at DATETIME(3) NOT NULL,
            updated_at DATETIME(3) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_product_store_lock (
            id TINYINT NOT NULL PRIMARY KEY,
            seeded TINYINT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_product_catalog (
            id TINYINT NOT NULL PRIMARY KEY,
            blob_path VARCHAR(512) NOT NULL
        ) ENGINE=InnoDB
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prebana_inventory_operations (
            order_id VARCHAR(64) NOT NULL PRIMARY KEY,
            status VARCHAR(16) NOT NULL,
            updated_at DATETIME(3) NOT NULL
        ) ENGINE=InnoDB
    `);
    await pool.execute("INSERT IGNORE INTO prebana_product_store_lock (id, seeded) VALUES (1, 0)");

    const connection = await pool.getConnection();
    let transactionStarted = false;
    try{
        await connection.beginTransaction();
        transactionStarted = true;
        const [rows] = await connection.execute("SELECT seeded FROM prebana_product_store_lock WHERE id = 1 FOR UPDATE");
        if (!Number(rows[0]?.seeded)){
            await insertProducts(connection, await readBundledProducts());
            await connection.execute("UPDATE prebana_product_store_lock SET seeded = 1 WHERE id = 1");
        }

        const [catalogRows] = await connection.execute(
            "SELECT blob_path AS blobPath FROM prebana_product_catalog WHERE id = 1 FOR UPDATE"
        );
        if (!catalogRows[0]?.blobPath){
            const legacyCatalog = await readBlobCatalog(legacyCatalogBlobPath, "private")
                || await readBlobCatalog(legacyCatalogBlobPath, "public");
            const catalog = legacyCatalog || {
                products: await readDatabaseProducts(connection),
                inventoryOperations: []
            };
            const databaseOperations = await readDatabaseInventoryOperations(connection);
            const operationsByOrder = new Map(
                databaseOperations.map((operation) => [operation.orderId, operation.status])
            );
            for (const operation of catalog.inventoryOperations){
                operationsByOrder.set(operation.orderId, operation.status);
            }
            await migrateLegacyProductImages(catalog.products);
            const blobPath = await writeBlobCatalog(catalog.products);
            await connection.execute(
                "INSERT INTO prebana_product_catalog (id, blob_path) VALUES (1, ?)",
                [blobPath]
            );
            await persistInventoryOperations(
                connection,
                [...operationsByOrder].map(([orderId, status]) => ({ orderId, status }))
            );
        }
        await connection.commit();
        transactionStarted = false;
    } catch(error){
        if (transactionStarted){
            try{
                await connection.rollback();
            } catch(rollbackError){
                throw new AggregateError([error, rollbackError], "Product storage initialization failed and its transaction could not be rolled back.");
            }
        }
        throw error;
    } finally{
        connection.release();
    }
}

async function ensureInitialized(){
    if (!initialization){
        initialization = initialize().catch((error) => {
            initialization = null;
            throw error;
        });
    }
    await initialization;
}

async function readProducts(){
    await ensureInitialized();
    const { catalog } = await readCurrentBlobCatalog(getPool());
    return catalog.products;
}

async function changeProducts(change, inventoryOperation = null){
    await ensureInitialized();
    const connection = await getPool().getConnection();
    let transactionStarted = false;
    try{
        await connection.beginTransaction();
        transactionStarted = true;
        await connection.execute("SELECT id FROM prebana_product_store_lock WHERE id = 1 FOR UPDATE");
        const { catalog } = await readCurrentBlobCatalog(connection);

        let result;
        let operationStatus;
        if (inventoryOperation){
            const [operationRows] = await connection.execute(
                "SELECT status FROM prebana_inventory_operations WHERE order_id = ? FOR UPDATE",
                [inventoryOperation.orderId]
            );
            operationStatus = operationRows[0]?.status;
            if (inventoryOperation.action === "reserve" && operationStatus === "reserved"){
                result = { alreadyApplied: true, skipWrite: true };
            } else if (inventoryOperation.action === "reserve" && operationStatus === "restored"){
                result = { error: "Inventory for this order has already been returned.", skipWrite: true };
            } else if (inventoryOperation.action === "restore" && operationStatus !== "reserved"){
                result = { alreadyApplied: true, skipWrite: true };
            }
        }
        if (!result){
            result = change(catalog.products);
        }
        if (!result.skipWrite){
            const blobPath = await writeBlobCatalog(catalog.products);
            await connection.execute(
                "UPDATE prebana_product_catalog SET blob_path = ? WHERE id = 1",
                [blobPath]
            );
            if (inventoryOperation){
                await persistInventoryOperations(connection, [{
                    orderId: inventoryOperation.orderId,
                    status: inventoryOperation.action === "restore" ? "restored" : "reserved"
                }]);
            }
        }
        await connection.commit();
        transactionStarted = false;
        return { ...result, products: catalog.products, productsCount: catalog.products.length };
    } catch(error){
        if (transactionStarted){
            try{
                await connection.rollback();
            } catch(rollbackError){
                throw new AggregateError([error, rollbackError], "Product change failed and its transaction could not be rolled back.");
            }
        }
        throw error;
    } finally{
        connection.release();
    }
}

module.exports = { changeProducts, readProducts };
