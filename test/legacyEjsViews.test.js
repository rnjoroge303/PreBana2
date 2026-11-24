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

test("storefront offers public browsing and shows account actions based on sign-in state", async () => {
    const viewPath = path.join(viewsDirectory, "client", "home.ejs");
    const guestHtml = await ejs.renderFile(viewPath, {
        products: [],
        isAuthenticated: false
    });
    const customerHtml = await ejs.renderFile(viewPath, {
        products: [],
        isAuthenticated: true
    });

    assert.match(guestHtml, /href="\/pre\/client\/login"/);
    assert.doesNotMatch(guestHtml, /href="\/pre\/orders"/);
    assert.match(guestHtml, /const isAuthenticated = false;/);
    assert.match(guestHtml, /\/pre\/client\/login\?next=%2Fpre%2Fcheckout/);
    assert.match(customerHtml, /href="\/pre\/orders"/);
    assert.match(customerHtml, /const isAuthenticated = true;/);
});

test("client sign-in and sign-up forms preserve a checkout return path", async () => {
    const loginHtml = await ejs.renderFile(path.join(viewsDirectory, "client", "login.ejs"), {
        error: null,
        next: "/pre/checkout"
    });
    const signupHtml = await ejs.renderFile(path.join(viewsDirectory, "client", "signup.ejs"), {
        error: null,
        next: "/pre/checkout"
    });

    assert.match(loginHtml, /name="next" value="\/pre\/checkout"/);
    assert.match(loginHtml, /\/pre\/client\/signup\?next=%2Fpre%2Fcheckout/);
    assert.match(signupHtml, /name="next" value="\/pre\/checkout"/);
    assert.match(signupHtml, /\/pre\/client\/login\?next=%2Fpre%2Fcheckout/);
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
