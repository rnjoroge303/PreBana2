const assert = require("node:assert/strict");
const test = require("node:test");
const { accountReference } = require("../src/controllers/paymentController");
const { getPayerName } = require("../src/controllers/callbackurl");

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

test("M-Pesa account reference shows the final four order characters", () => {
    assert.equal(accountReference("PB-20261124-2694E5"), "ORD94E5");
});
