const assert = require("node:assert/strict");
const test = require("node:test");
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
