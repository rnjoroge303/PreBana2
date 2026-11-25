const fs = require("node:fs/promises");
const path = require("node:path");

const shippingFile = path.join(__dirname, "..", "data", "shipping.json");
const shippingBlobPath = "shipping/rates.json";
let writeQueue = Promise.resolve();

const COUNTIES = [
    "Baringo", "Bomet", "Bungoma", "Busia", "Elgeyo-Marakwet", "Embu", "Garissa",
    "Homa Bay", "Isiolo", "Kajiado", "Kakamega", "Kericho", "Kiambu", "Kilifi",
    "Kirinyaga", "Kisii", "Kisumu", "Kitui", "Kwale", "Laikipia", "Lamu",
    "Machakos", "Makueni", "Mandera", "Marsabit", "Meru", "Migori", "Mombasa",
    "Murang'a", "Nairobi", "Nakuru", "Nandi", "Narok", "Nyamira", "Nyandarua",
    "Nyeri", "Samburu", "Siaya", "Taita-Taveta", "Tana River", "Tharaka-Nithi",
    "Trans Nzoia", "Turkana", "Uasin Gishu", "Vihiga", "Wajir", "West Pokot"
];

function normalizeRates(value){
    const source = value && typeof value === "object" ? value : {};
    const rates = {};
    for (const county of COUNTIES){
        const fee = Number(source[county]);
        rates[county] = Number.isFinite(fee) && fee >= 0 ? Math.round(fee * 100) / 100 : 0;
    }
    return rates;
}

async function readLocalRates(){
    try{
        const data = JSON.parse(await fs.readFile(shippingFile, "utf8"));
        return normalizeRates(data.rates);
    } catch(error){
        if (error.code === "ENOENT"){
            return normalizeRates({});
        }
        throw error;
    }
}

async function writeLocalRates(rates){
    await fs.mkdir(path.dirname(shippingFile), { recursive: true });
    const temporaryFile = `${shippingFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ rates }, null, 2), "utf8");
    await fs.rename(temporaryFile, shippingFile);
}

async function readRates(){
    if (process.env.VERCEL !== "1"){
        return readLocalRates();
    }
    const blob = require("@vercel/blob");
    const result = await blob.list({ prefix: shippingBlobPath, limit: 1 });
    if (!result.blobs.length){
        return normalizeRates({});
    }
    const response = await fetch(result.blobs[0].downloadUrl);
    if (!response.ok){
        throw new Error("Could not load shipping rates.");
    }
    const data = await response.json();
    return normalizeRates(data.rates);
}

async function updateRates(input){
    const rates = normalizeRates(input);
    if (process.env.VERCEL !== "1"){
        const operation = writeQueue.then(() => writeLocalRates(rates));
        writeQueue = operation.catch(() => {});
        await operation;
        return rates;
    }
    const blob = require("@vercel/blob");
    await blob.put(shippingBlobPath, JSON.stringify({ rates }), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json"
    });
    return rates;
}

module.exports = { COUNTIES, normalizeRates, readRates, updateRates };
