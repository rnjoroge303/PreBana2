const shippingStore = require("../models/shippingStore");

async function listShippingRates(req, res, next){
    try{
        res.set("Cache-Control", "no-store");
        return res.json({
            counties: shippingStore.COUNTIES,
            rates: await shippingStore.readRates()
        });
    } catch(error){
        return next(error);
    }
}

async function updateShippingRates(req, res, next){
    try{
        const source = req.body?.rates && typeof req.body.rates === "object"
            ? req.body.rates
            : req.body;
        const rates = await shippingStore.updateRates(source);
        return res.json({ success: true, counties: shippingStore.COUNTIES, rates });
    } catch(error){
        return next(error);
    }
}

module.exports = { listShippingRates, updateShippingRates };
