const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const viewsDirectory = path.join(__dirname, "..", "src", "views");

test("payment EJS view renders its page title", async () => {
    const html = await ejs.renderFile(path.join(viewsDirectory, "pay.ejs"), {
        pageTitle: "Payment"
    });

    assert.match(html, /<title>Payment<\/title>/);
});

test("receipt EJS view escapes database fields and links to the invoice PDF", async () => {
    const html = await ejs.renderFile(path.join(viewsDirectory, "finalReciptpdf.ejs"), {
        receipt: {
            status: "confirmed",
            mpesa_receipt: "<script>alert(1)</script>",
            phone_number: "254700000000",
            order_recipient_name: "Customer",
            order_shipping_location: "Nairobi",
            amount: 125,
            order_id: 14,
            product_id: 27,
            quantity: 1,
            checkout_request_id: "ws_CO_test/receipt"
        }
    });

    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /\/invoice\/ws_CO_test%2Freceipt\.pdf/);
});
