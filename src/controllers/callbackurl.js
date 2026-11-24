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

function maskPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length > 4 ? `${digits.slice(0, 3)}******${digits.slice(-2)}` : value ?? null;
}

function getCallbackLogPayload(callback) {
    const callbackMetadata = callback.CallbackMetadata;
    const items = callbackMetadata?.Item;
    const redactPhone = (item) => item?.Name === 'PhoneNumber'
        ? { ...item, Value: maskPhone(item.Value) }
        : item;
    const loggedItems = Array.isArray(items)
        ? items.map(redactPhone)
        : items ? redactPhone(items) : items;

    return {
        ...callback,
        ...(callbackMetadata ? {
            CallbackMetadata: {
                ...callbackMetadata,
                ...(items ? { Item: loggedItems } : {})
            }
        } : {})
    };
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
    console.info('[M-Pesa callback] HTTP request received', {
        method: req.method,
        path: req.originalUrl || req.url,
        contentType: req.get?.('content-type') || req.headers?.['content-type'] || null,
        hasBody: Boolean(req.body)
    });
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

    if (resultCode === 0) {
        console.info('[M-Pesa callback] Complete transaction payload', getCallbackLogPayload(callback));
    } else {
        console.info('[M-Pesa callback] Safaricom payload', {
            checkoutRequestId,
            merchantRequestId: callback.MerchantRequestID || null,
            resultCode,
            resultDescription: String(callback.ResultDesc || '').slice(0, 255),
            metadata: {
                amount: metadata.Amount ?? null,
                receipt,
                transactionDate: metadata.TransactionDate ?? null,
                phoneNumber: maskPhone(metadata.PhoneNumber)
            }
        });
    }

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
        console.info('[M-Pesa callback processed]', {
            checkoutRequestId,
            paymentStatus: order.paymentStatus,
            resultCode
        });
        return acknowledge(res);
    } catch (error) {
        console.error('[M-Pesa callback] Payment update failed:', error.message);
        return acknowledge(res);
    }
}

module.exports = { getCallbackLogPayload, getPayerName, handleMpesaCallback };
