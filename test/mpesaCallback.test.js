const assert = require("node:assert/strict");
const test = require("node:test");
const { getCallbackLogPayload, getPayerName } = require("../src/controllers/callbackurl");

test("M-Pesa callback payer name prefers a supplied full name", () => {
    assert.equal(getPayerName({
        PayerName: " M-Pesa Payer ",
        FirstName: "Different",
        LastName: "Name"
    }), "M-Pesa Payer");
});

test("M-Pesa callback payer name combines available name parts and handles missing names", () => {
    assert.equal(getPayerName({
        FirstName: "Jane",
        MiddleName: "A",
        LastName: "Doe"
    }), "Jane A Doe");
    assert.equal(getPayerName({ PhoneNumber: 254700000000 }), null);
});

test("complete callback log retains all fields while masking the payer phone", () => {
    const payload = {
        CheckoutRequestID: "ws_CO_test",
        ResultCode: 0,
        ResultDesc: "Success",
        CallbackMetadata: {
            Item: [
                { Name: "Amount", Value: 100 },
                { Name: "MpesaReceiptNumber", Value: "ABC123" },
                { Name: "PhoneNumber", Value: 254712345678 },
                { Name: "FirstName", Value: "Jane" }
            ]
        }
    };
    const loggedPayload = getCallbackLogPayload(payload);

    assert.equal(loggedPayload.CheckoutRequestID, payload.CheckoutRequestID);
    assert.deepEqual(loggedPayload.CallbackMetadata.Item.map((item) => item.Name), [
        "Amount",
        "MpesaReceiptNumber",
        "PhoneNumber",
        "FirstName"
    ]);
    assert.equal(loggedPayload.CallbackMetadata.Item[2].Value, "254******78");
    assert.equal(payload.CallbackMetadata.Item[2].Value, 254712345678);
});
