const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
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

test("admin product image paths bypass browser URL validation", async () => {
    const formHtml = await ejs.renderFile(path.join(viewsDirectory, "admin", "includes", "product.ejs"), {
        productId: "PB-TEST-1"
    });
    const dashboardScript = await fs.readFile(path.join(viewsDirectory, "admin", "dashboard.ejs"), "utf8");

    assert.match(formHtml, /id="adminProductForm"[^>]*novalidate/);
    assert.match(dashboardScript, /input\.type = "text";\s*input\.inputMode = "url";/);
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

test("product cards show stock and expose the limit used by the shopping bag", async () => {
    const html = await ejs.renderFile(path.join(viewsDirectory, "client", "includes", "productCard.ejs"), {
        product: {
            id: "PB-TEST-1",
            name: "Test lotion",
            category: "body",
            description: "Daily care",
            price: 250,
            stock: 3,
            images: []
        }
    });

    assert.match(html, /data-stock="3"/);
    assert.match(html, /<p class="productStock"><strong>3<\/strong> available<\/p>/);
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
