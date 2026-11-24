const PDFDocument = require("pdfkit");

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatCurrency(value) {
    return `KSh ${Number(value || 0).toLocaleString("en-KE")}`;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "—"
        : date.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
}

function maskPhone(value) {
    const phone = String(value || "");
    if (phone.length < 7) return phone || "—";
    return `${phone.slice(0, 3)}${"*".repeat(phone.length - 6)}${phone.slice(-3)}`;
}

function formatPaymentStatus(order) {
    const labels = {
        paid: "PAID",
        pending: "PENDING",
        awaiting_verification: "CODE SUBMITTED",
        failed: "FAILED",
        cancelled: "CANCELLED",
        review_required: "REVIEW REQUIRED"
    };
    return labels[order.paymentStatus]
        || String(order.paymentStatus || "pending").replace(/_/g, " ").toUpperCase();
}

function buildThermalReceiptHtml(order, options = {}) {
    const items = Array.isArray(order.items) ? order.items : [];
    const rows = items.map((item) => `
        <tr>
            <td>${escapeHtml(item.name || "Product")} × ${Number(item.quantity || 0)}</td>
            <td>${formatCurrency(item.lineTotal || 0)}</td>
        </tr>`).join("");
    const pdfUrl = options.pdfUrl || `/pre/orders/${encodeURIComponent(order.id)}/receipt.pdf`;
    const backUrl = options.backUrl || "/pre/store";
    const backLabel = options.backLabel || "Back to shop";
    const customerUrl = options.customerUrl;
    const customerLabel = options.customerLabel || "Customer page";
    const receiptTitle = options.receiptTitle || "Customer receipt";
    const totalLabel = order.paymentStatus === "paid" ? "Total paid" : "Order total";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PreBana Receipt - ${escapeHtml(order.id)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 20px auto; padding: 16px; width: min(100%, 360px); color: #172533; font: 14px Arial, sans-serif; }
    .receipt { border: 1px solid #e5e7eb; padding: 18px; }
    .brand-link { color: inherit; text-decoration: none; }
    h1 { margin: 0; font-size: 20px; text-align: center; }
    .subtitle { margin: 5px 0 16px; color: #5f6b78; text-align: center; }
    .line { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px dashed #bbb; }
    .line > span:last-child, .line > strong:last-child { min-width: 0; overflow-wrap: anywhere; text-align: right; }
    .section { margin-top: 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
    table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; }
    td { padding: 5px 0; vertical-align: top; }
    td:first-child { overflow-wrap: anywhere; }
    td:last-child { text-align: right; white-space: nowrap; }
    .total { margin-top: 12px; border-top: 1px solid #222; padding-top: 8px; font-size: 16px; font-weight: bold; text-align: right; }
    .actions { display: flex; justify-content: center; gap: 8px; margin: 14px auto; }
    .actions a, .actions button { border: 0; border-radius: 4px; padding: 10px 12px; background: #17372f; color: white; font: inherit; font-size: 12px; text-decoration: none; cursor: pointer; }
    @page { size: 80mm auto; margin: 3mm; }
    @media print {
      body { width: 74mm; margin: 0; padding: 0; }
      .receipt { border: 0; padding: 0; }
      .actions { display: none; }
      tr, .line { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="receipt">
    <a class="brand-link" href="/pre/store"><h1>PreBana Cosmetics</h1></a>
    <p class="subtitle">${escapeHtml(receiptTitle)}</p>
    <div class="line"><span>Order</span><strong>${escapeHtml(order.id)}</strong></div>
    <div class="line"><span>Date</span><span>${escapeHtml(formatDate(order.createdAt))}</span></div>
    <div class="line"><span>Status</span><strong>${escapeHtml(formatPaymentStatus(order))}</strong></div>
    <div class="line"><span>M-Pesa code</span><strong>${escapeHtml(order.mpesa?.receipt || order.paymentReference || "—")}</strong></div>
    <p class="section">Paid by</p>
    <div class="line"><span>Name</span><span>${escapeHtml(order.mpesa?.payerName || order.customer?.name || "—")}</span></div>
    <div class="line"><span>M-Pesa phone</span><span>${escapeHtml(maskPhone(order.paymentPhone || order.customer?.phone))}</span></div>
    <p class="section">Delivery</p>
    <div class="line"><span>Recipient</span><span>${escapeHtml(order.customer?.name || "—")}</span></div>
    <div class="line"><span>Phone</span><span>${escapeHtml(order.customer?.phone || "—")}</span></div>
    <div class="line"><span>Location</span><span>${escapeHtml(order.customer?.address || "—")}</span></div>
    <p class="section">Items</p>
    <table><tbody>${rows || "<tr><td>No items listed</td><td></td></tr>"}</tbody></table>
    <div class="total">${totalLabel}: ${formatCurrency(order.total)}</div>
  </main>
  <nav class="actions" aria-label="Receipt actions">
    <button type="button" onclick="window.print()">Print receipt</button>
    <a href="${escapeHtml(pdfUrl)}">Download PDF</a>
    <a href="${escapeHtml(backUrl)}">${escapeHtml(backLabel)}</a>
    ${customerUrl ? `<a href="${escapeHtml(customerUrl)}">${escapeHtml(customerLabel)}</a>` : ""}
  </nav>
</body>
</html>`;
}

function cleanPdfText(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\x20-\x7E]/g, "?");
}

function wrapText(value, maxLength = 38) {
    const words = cleanPdfText(value).split(/\s+/);
    const lines = [];
    let line = "";

    for (let word of words) {
        while (word.length > maxLength) {
            if (line) {
                lines.push(line);
                line = "";
            }
            lines.push(word.slice(0, maxLength));
            word = word.slice(maxLength);
        }
        if (!word) continue;
        if (line && line.length + word.length + 1 > maxLength) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }

    if (line) lines.push(line);
    return lines;
}

function buildThermalReceiptPdf(order, options = {}) {
    const lines = [];
    const addLine = (text, options = {}) => {
        for (const wrapped of wrapText(text, options.maxLength || 38)) {
            lines.push({
                text: wrapped,
                bold: Boolean(options.bold),
                size: options.size || 9,
                gap: options.gap ?? 3
            });
        }
    };
    const items = Array.isArray(order.items) ? order.items : [];
    const receiptCode = order.mpesa?.receipt || order.paymentReference || "—";

    addLine("PreBana Cosmetics", { bold: true, size: 14, gap: 2, maxLength: 30 });
    addLine(options.receiptTitle || "CUSTOMER RECEIPT", { bold: true, size: 10, gap: 5 });
    addLine(`Order: ${order.id}`);
    addLine(`Date: ${formatDate(order.createdAt)}`);
    addLine(`Status: ${formatPaymentStatus(order)}`);
    addLine(`M-Pesa code: ${receiptCode}`);
    addLine("--------------------------------------");
    addLine("PAID BY", { bold: true, size: 9, gap: 2 });
    addLine(`Name: ${order.mpesa?.payerName || order.customer?.name || "—"}`);
    addLine(`M-Pesa phone: ${maskPhone(order.paymentPhone || order.customer?.phone)}`);
    addLine("--------------------------------------");
    addLine("DELIVERY", { bold: true, size: 9, gap: 2 });
    addLine(`Recipient: ${order.customer?.name || "—"}`);
    addLine(`Phone: ${order.customer?.phone || "—"}`);
    addLine(`Location: ${order.customer?.address || "—"}`);
    addLine("--------------------------------------");
    addLine("ITEMS", { bold: true, size: 9, gap: 2 });
    items.forEach((item) => {
        addLine(`${item.name || "Product"} x${Number(item.quantity || 0)}`);
        addLine(formatCurrency(item.lineTotal || 0), { gap: 5 });
    });
    addLine("--------------------------------------");
    const totalLabel = order.paymentStatus === "paid" ? "TOTAL PAID" : "ORDER TOTAL";
    addLine(`${totalLabel}: ${formatCurrency(order.total)}`, { bold: true, size: 11, gap: 2 });

    const width = 226.77;
    const height = Math.max(250, 24 + lines.reduce((sum, line) => sum + line.size + line.gap + 2, 0));
    const document = new PDFDocument({ size: [width, height], margin: 12, compress: true });

    return new Promise((resolve, reject) => {
        const chunks = [];
        document.on("data", (chunk) => chunks.push(chunk));
        document.on("error", reject);
        document.on("end", () => resolve(Buffer.concat(chunks)));

        let y = 12;
        for (const line of lines) {
            document
                .font(line.bold ? "Helvetica-Bold" : "Helvetica")
                .fontSize(line.size)
                .fillColor("#000000")
                .text(line.text, 12, y, { lineBreak: false });
            y += line.size + line.gap + 2;
        }
        document.end();
    });
}

module.exports = { buildThermalReceiptHtml, buildThermalReceiptPdf };
