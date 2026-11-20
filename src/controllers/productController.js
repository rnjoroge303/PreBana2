const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const dataDirectory = path.join(__dirname, "..", "data");
const dataFile = path.join(dataDirectory, "data.json");
const uploadDirectory = path.join(__dirname, "..", "..", "public", "uploads", "products");
const validCategories = new Set(["featured", "hair", "face", "body", "baby", "nails", "mens"]);
let writeQueue = Promise.resolve();

function generateProductId(products = []){
    const existingIds = new Set(products.map((product) => product.id));
    let productId;

    do{
        const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
        productId = `PB-${date}-${suffix}`;
    } while (existingIds.has(productId));

    return productId;
}

async function readProducts(){
    try{
        const contents = await fs.readFile(dataFile, "utf8");
        const data = JSON.parse(contents);
        return Array.isArray(data) ? data : Array.isArray(data.products) ? data.products : [];
    } catch(error){
        if (error.code === "ENOENT"){
            return [];
        }
        throw error;
    }
}

async function removeUploadedFiles(files){
    await Promise.all((files || []).map((file) => fs.unlink(file.path).catch(() => {})));
}

async function removeUnreferencedUploads(previousImages, products){
    const referencedImages = new Set(products.flatMap((product) => (product.images || []).map((image) => image.url)));
    const obsoleteImages = (previousImages || []).filter((image) => image.url.startsWith("/uploads/products/") && !referencedImages.has(image.url));
    await Promise.all(obsoleteImages.map((image) => {
        const filename = path.basename(image.url);
        return fs.unlink(path.join(uploadDirectory, filename)).catch(() => {});
    }));
}

async function isValidImageFile(file){
    const handle = await fs.open(file.path, "r");
    try{
        const header = Buffer.alloc(12);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const bytes = header.subarray(0, bytesRead);

        if (file.mimetype === "image/jpeg"){
            return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        }
        if (file.mimetype === "image/png"){
            return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        }
        if (file.mimetype === "image/webp"){
            return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
        }
        if (file.mimetype === "image/avif"){
            return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12));
        }
        return false;
    } finally{
        await handle.close();
    }
}

async function persistProducts(products){
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ products }, null, 2), "utf8");
    await fs.rename(temporaryFile, dataFile);
}

function queueProductChange(change){
    const writeOperation = writeQueue.then(async () => {
        const products = await readProducts();
        const result = change(products);
        if (!result.skipWrite){
            await persistProducts(products);
        }
        if (result.previousImages){
            await removeUnreferencedUploads(result.previousImages, products);
        }
        return { ...result, productsCount: products.length };
    });

    writeQueue = writeOperation.catch(() => {});
    return writeOperation;
}

async function saveProduct(product){
    const result = await queueProductChange((products) => {
        if (products.some((existing) => existing.id === product.id)){
            product.id = generateProductId(products);
        }
        products.unshift(product);
        return { product };
    });
    return result.productsCount;
}

async function updateProductRecord(productId, updates){
    return queueProductChange((products) => {
        const productIndex = products.findIndex((product) => product.id === productId);
        if (productIndex < 0){
            return { notFound: true, skipWrite: true };
        }
        const previousProduct = products[productIndex];
        const product = {
            ...previousProduct,
            ...updates,
            id: previousProduct.id,
            updatedAt: new Date().toISOString()
        };
        products[productIndex] = product;
        return { product, previousImages: previousProduct.images || [] };
    });
}

async function deleteProductRecord(productId){
    return queueProductChange((products) => {
        const productIndex = products.findIndex((product) => product.id === productId);
        if (productIndex < 0){
            return { notFound: true, skipWrite: true };
        }
        const [product] = products.splice(productIndex, 1);
        return { product, previousImages: product.images || [] };
    });
}

async function reserveStock(items){
    return queueProductChange((products) => {
        const orderProducts = [];
        for (const item of items){
            const product = products.find((entry) => entry.id === item.productId);
            if (!product){
                return { error: "A product in your bag is no longer available.", skipWrite: true };
            }
            if (item.quantity > product.stock){
                return { error: `${product.name} has only ${product.stock} available.`, skipWrite: true };
            }
            orderProducts.push({ product, quantity: item.quantity });
        }

        const itemsForOrder = orderProducts.map(({ product, quantity }) => ({
            productId: product.id,
            name: product.name,
            quantity,
            unitPrice: product.price,
            lineTotal: product.price * quantity
        }));
        orderProducts.forEach(({ product, quantity }) => {
            product.stock -= quantity;
        });
        return { itemsForOrder };
    });
}

async function restoreStock(items){
    return queueProductChange((products) => {
        items.forEach((item) => {
            const product = products.find((entry) => entry.id === item.productId);
            if (product){
                product.stock += item.quantity;
            }
        });
        return {};
    });
}

function normalizeImageUrls(value){
    const submitted = Array.isArray(value) ? value : value ? [value] : [];
    return submitted.map((url) => String(url).trim()).filter(Boolean);
}

function parseImageUrl(value){
    if (/^\/uploads\/products\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp|avif)$/i.test(value)){
        return true;
    }
    let parsedUrl;
    try{
        parsedUrl = new URL(value);
    } catch{
        return false;
    }
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:";
}

async function validateProductFields(req, uploadedFiles){
    const name = String(req.body.name || "").trim();
    const category = String(req.body.category || "").trim();
    const description = String(req.body.description || "").trim();
    const price = Number(req.body.price);
    const stock = Number(req.body.stock || 0);
    const imageUrls = normalizeImageUrls(req.body.imageUrls);

    if (!name || name.length > 80){
        return { error: "Enter a product name up to 80 characters." };
    }
    if (!description || description.length > 240){
        return { error: "Enter a product description up to 240 characters." };
    }
    if (!validCategories.has(category)){
        return { error: "Choose a valid product category." };
    }
    if (!Number.isFinite(price) || price <= 0){
        return { error: "Enter a price greater than zero." };
    }
    if (!Number.isInteger(stock) || stock < 0){
        return { error: "Stock must be a whole number of zero or more." };
    }
    if (uploadedFiles.length + imageUrls.length > 6){
        return { error: "Add no more than six images or image links." };
    }
    for (const file of uploadedFiles){
        if (!await isValidImageFile(file)){
            return { error: "An uploaded file is not a valid supported image." };
        }
    }
    if (imageUrls.some((url) => !parseImageUrl(url))){
        return { error: "Image links must be HTTP or HTTPS links, or previously uploaded product images." };
    }
    for (const url of imageUrls){
        if (url.startsWith("/uploads/products/")){
            try{
                await fs.access(path.join(uploadDirectory, path.basename(url)));
            } catch{
                return { error: "An existing uploaded image could not be found." };
            }
        }
    }

    return {
        fields: {
            name,
            category,
            description,
            price,
            stock,
            images: [
                ...uploadedFiles.map((file) => ({
                    url: `/uploads/products/${file.filename}`,
                    alt: name
                })),
                ...imageUrls.map((url) => ({ url, alt: name }))
            ]
        }
    };
}

async function showStore(req, res, next){
    try{
        const products = await readProducts();
        res.render("home", { products });
    } catch(error){
        next(error);
    }
}

async function showAdmin(req, res, next){
    try{
        const products = await readProducts();
        res.render("dashboard", {
            products,
            productId: generateProductId(products)
        });
    } catch(error){
        next(error);
    }
}

async function createProduct(req, res, next){
    const uploadedFiles = req.files || [];
    try{
        const validation = await validateProductFields(req, uploadedFiles);
        if (validation.error){
            await removeUploadedFiles(uploadedFiles);
            return res.status(400).json({ error: validation.error });
        }

        const products = await readProducts();
        const id = generateProductId(products);
        const product = {
            id,
            ...validation.fields,
            createdAt: new Date().toISOString()
        };

        const productsCount = await saveProduct(product);
        const savedProducts = await readProducts();
        return res.status(201).json({
            product,
            productsCount,
            nextProductId: generateProductId(savedProducts)
        });
    } catch(error){
        await removeUploadedFiles(uploadedFiles);
        return next(error);
    }
}

async function updateProduct(req, res, next){
    const uploadedFiles = req.files || [];
    try{
        const validation = await validateProductFields(req, uploadedFiles);
        if (validation.error){
            await removeUploadedFiles(uploadedFiles);
            return res.status(400).json({ error: validation.error });
        }

        const result = await updateProductRecord(req.params.id, validation.fields);
        if (result.notFound){
            await removeUploadedFiles(uploadedFiles);
            return res.status(404).json({ error: "Product not found." });
        }
        return res.json({ product: result.product, productsCount: result.productsCount });
    } catch(error){
        await removeUploadedFiles(uploadedFiles);
        return next(error);
    }
}

async function deleteProduct(req, res, next){
    try{
        const result = await deleteProductRecord(req.params.id);
        if (result.notFound){
            return res.status(404).json({ error: "Product not found." });
        }
        return res.json({ productId: req.params.id, productsCount: result.productsCount });
    } catch(error){
        return next(error);
    }
}

module.exports = {
    createProduct,
    deleteProduct,
    generateProductId,
    readProducts,
    reserveStock,
    restoreStock,
    showAdmin,
    showStore,
    updateProduct
};
