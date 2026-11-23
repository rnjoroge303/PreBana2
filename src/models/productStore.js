const fs = require("node:fs/promises");
const path = require("node:path");

const bundledProductsFile = path.join(__dirname, "..", "data", "data.json");
let initialization;

function getPool(){
    return require("../db/db");
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

async function readProducts(connection){
    await ensureInitialized();
    const executor = connection || getPool();
    const [rows] = await executor.execute(`
        SELECT id, name, category, description, price, stock, images,
               created_at AS createdAt, updated_at AS updatedAt
        FROM prebana_products
        ORDER BY created_at DESC
    `);
    return rows.map(fromDatabaseRow);
}

async function writeProducts(connection, products){
    await connection.execute("DELETE FROM prebana_products");
    await insertProducts(connection, products);
}

async function changeProducts(change){
    await ensureInitialized();
    const connection = await getPool().getConnection();
    let transactionStarted = false;
    try{
        await connection.beginTransaction();
        transactionStarted = true;
        await connection.execute("SELECT id FROM prebana_product_store_lock WHERE id = 1 FOR UPDATE");
        const products = await readProducts(connection);
        const result = change(products);
        if (!result.skipWrite){
            await writeProducts(connection, products);
        }
        await connection.commit();
        transactionStarted = false;
        return { ...result, products, productsCount: products.length };
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
