const checkoutController = require('./checkoutController');

function acknowledge(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

function getCallbackMetadata(callback) {
    const items = callback.CallbackMetadata?.Item;
    const itemList = Array.isArray(items) ? items : (items ? [items] : []);

    return itemList.reduce((metadata, item) => {
        if (item && typeof item.Name === 'string') {
            metadata[item.Name] = item.Value;
        }
        return metadata;
    }, {});
}

function getPayerName(metadata) {
    const explicitName = [metadata.PayerName, metadata.CustomerName, metadata.Name]
        .find((value) => typeof value === 'string' && value.trim());
    const name = explicitName || [
        metadata.FirstName,
        metadata.MiddleName,
        metadata.LastName
    ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
    return typeof name === 'string' ? name.trim().slice(0, 100) || null : null;
}

async function handleMpesaCallback(req, res) {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
        console.warn('[M-Pesa callback] Missing stkCallback payload', {
            topLevelKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : []
        });
        return acknowledge(res);
    }

    const checkoutRequestId = String(callback.CheckoutRequestID || '').trim();
    const rawResultCode = callback.ResultCode;
    const resultCode = typeof rawResultCode === 'number'
        ? rawResultCode
        : typeof rawResultCode === 'string' && rawResultCode.trim() !== ''
            ? Number(rawResultCode)
            : Number.NaN;
    if (!checkoutRequestId || !Number.isInteger(resultCode)) {
        console.warn('[M-Pesa callback] Missing checkout request ID or valid result code');
        return acknowledge(res);
    }

    const metadata = getCallbackMetadata(callback);
    const receipt = typeof metadata.MpesaReceiptNumber === 'string'
        ? metadata.MpesaReceiptNumber
        : null;

    try {
        const order = await checkoutController.applyMpesaCallback(checkoutRequestId, {
            resultCode,
            resultDescription: String(callback.ResultDesc || '').slice(0, 255),
            receipt,
            amount: metadata.Amount,
            payerName: getPayerName(metadata)
        });
        if (!order) {
            console.error('[M-Pesa callback] No order matches checkout request; check whether this app instance stored the STK request', {
                checkoutRequestId,
                merchantRequestId: callback.MerchantRequestID || null
            });
            return acknowledge(res);
        }
        return acknowledge(res);
    } catch (error) {
        console.error('[M-Pesa callback] Payment update failed:', error.message);
        return acknowledge(res);
    }
}

module.exports = { getPayerName, handleMpesaCallback };
