const assert = require("node:assert/strict");
const test = require("node:test");
const { buildThermalReceiptHtml, buildThermalReceiptPdf } = require("../src/controllers/receiptController");

test("admin receipt page offers thermal printing and an admin PDF download", async () => {
    const order = {
        id: "PB-20261124-ABC123",
        createdAt: "2026-11-24T00:00:00.000Z",
        paymentStatus: "pending",
        total: 10,
        customer: { name: "Customer", phone: "+254700000000", address: "Nairobi" },
        items: [{ name: "Lotion", quantity: 1, lineTotal: 10 }]
    };
    const html = buildThermalReceiptHtml(order, {
        pdfUrl: "/pre/admin/orders/PB-20261124-ABC123/receipt.pdf",
        backUrl: "/pre/admin#accounts",
        backLabel: "Back to customers"
    });

    assert.match(html, /@page \{ size: 80mm auto;/);
    assert.match(html, /window\.print\(\)/);
    assert.match(html, /Download PDF/);
    assert.match(html, /\/pre\/admin\/orders\/PB-20261124-ABC123\/receipt\.pdf/);
    assert.match(html, /\/pre\/admin#accounts/);
    assert.match(html, /Back to customers/);
    assert.match(html, /PENDING/);
    assert.match(html, /Order total: KSh 10/);

    const pdf = await buildThermalReceiptPdf(order);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
});
