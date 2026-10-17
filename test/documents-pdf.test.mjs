import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { renderPdf, renderReceiptPdf } from "../server/pdf.mjs";
import { renderStatementPdf } from "../server/statement.mjs";
import { cjkFontPath, collectionNames, loadFontFace } from "../server/documents-fonts.mjs";
import { PNG_1PX } from "./helpers.mjs";

// Records every string and image pdfkit draws while rendering.
async function capture(fn) {
  const text = PDFDocument.prototype.text,
    image = PDFDocument.prototype.image,
    font = PDFDocument.prototype.font;
  const out = { text: [], images: [], fonts: new Set() };
  PDFDocument.prototype.text = function (value, ...rest) {
    out.text.push(String(value));
    return text.call(this, value, ...rest);
  };
  PDFDocument.prototype.image = function (src, ...rest) {
    out.images.push(src);
    return image.call(this, src, ...rest);
  };
  PDFDocument.prototype.font = function (name, ...rest) {
    out.fonts.add(name);
    return font.call(this, name, ...rest);
  };
  try {
    out.pdf = await fn();
  } finally {
    Object.assign(PDFDocument.prototype, { text, image, font });
  }
  out.all = out.text.join("\n");
  return out;
}
const setup = () => {
  const store = openDatabase(":memory:");
  store.saveSettings({ registration: "TEST-001", address: "Test office", email: "billing@example.com", bankAccount: "5140-1234", bankName: "Maybank" });
  const client = store.saveClient({ name: "Klien Ujian", email: "c@example.com", tin: "C1234567890", terms: 14 });
  const draft = (b = {}) =>
    store.saveDocument({
      kind: "invoice",
      client_id: client.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Integration", quantity: 1, rate: "1000.00" }],
      ...b,
    });
  return { store, client, draft };
};

test("the default PDF keeps today's labels, columns and look", async () => {
  const { store, draft } = setup();
  try {
    const d = store.issue(draft().id);
    const r = await capture(() => renderPdf(store.document(d.id)));
    for (const s of ["INVOICE", "BILL TO", "DOCUMENT DETAILS", "DESCRIPTION", "QTY", "RATE (RM)", "AMOUNT", "Subtotal", "Discount", "Original total", "Balance due", "Payment information", "Terms"])
      assert.ok(r.text.includes(s), s);
    assert.ok(!r.all.includes("CODE") && !r.all.includes("UNIT"), "no code or unit column without codes");
    assert.match(r.all, /Nawlogic \| Business document \| Not a validated MyInvois e-Invoice/);
    assert.equal(typeof r.images[0], "string", "the Nawlogic logo file");
  } finally {
    store.db.close();
  }
});

test("codes, units and line discounts get their own columns only when used", async () => {
  const { store, draft } = setup();
  try {
    const svc = store.saveService({ name: "Router", rate: "450.00", unit: "Unit", sku: "RT-1" });
    const d = draft({
      items: [
        { description: "Router", quantity: 2, rate: "450.00", service_id: svc.id, discount_percent: "10" },
        { description: "Setup", quantity: 1, rate: "200.00" },
      ],
    });
    const r = await capture(() => renderPdf(store.document(d.id)));
    for (const s of ["CODE", "UNIT", "DISCOUNT", "RT-1", "Unit", "90.00\n10%"]) assert.ok(r.text.includes(s), s);
  } finally {
    store.db.close();
  }
});

test("delivery orders show items and quantities without prices, with signature lines", async () => {
  const { store, draft } = setup();
  try {
    const d = store.issue(draft({ kind: "delivery_order", items: [{ description: "Router", quantity: 3, rate: "0", unit: "Unit" }] }).id);
    const r = await capture(() => renderPdf(store.document(d.id)));
    for (const s of ["DELIVERY ORDER", "DELIVER TO", "QTY", "UNIT", "DELIVERED BY", "RECEIVED BY", "Signature & stamp"]) assert.ok(r.text.includes(s), s);
    assert.ok(!r.text.some((s) => /^RATE|^AMOUNT|Balance due|Subtotal|Payment information/.test(s)), "no prices or payment");
  } finally {
    store.db.close();
  }
});

test("Bahasa Melayu labels, other currencies and the exchange rate", async () => {
  const { store, draft } = setup();
  try {
    const d = store.issue(draft({ language: "ms", currency: "USD", fx_rate: "4.45" }).id);
    const r = await capture(() => renderPdf(store.document(d.id)));
    for (const s of ["INVOIS", "BIL KEPADA", "PERIHAL", "Baki perlu dibayar", "Maklumat pembayaran"]) assert.ok(r.text.includes(s), s);
    assert.match(r.all, /Kadar tukaran: 1 USD = 4\.45 MYR/);
    assert.match(r.all, /US\$1,000\.00/);
    assert.match(r.all, /HARGA \(USD\)/);
  } finally {
    store.db.close();
  }
});

const font = cjkFontPath(process.env.PDF_CJK_FONT);
test("Chinese documents use a CJK font from the system or PDF_CJK_FONT", { skip: !font && "no CJK font installed" }, async () => {
  const { store, draft } = setup();
  try {
    const d = store.issue(draft({ language: "zh", items: [{ description: "网站设计 Website", quantity: 1, rate: "10" }] }).id);
    const r = await capture(() => renderPdf(store.document(d.id)));
    assert.ok(r.text.includes("发票"));
    assert.ok(r.text.includes("网站设计 Website\n") || r.text.some((s) => s.startsWith("网站设计")));
    assert.ok(r.fonts.has("CJK"), "CJK text is drawn with the CJK font");
    assert.ok(r.fonts.has("Body"), "Latin-only text keeps DejaVu");
    const face = loadFontFace(font);
    assert.ok(face.data.length > 1000);
    // English documents switch fonts only for the strings that need it.
    const en = store.issue(draft({ items: [{ description: "陈氏 consulting", quantity: 1, rate: "10" }] }).id);
    const e = await capture(() => renderPdf(store.document(en.id)));
    assert.ok(e.fonts.has("CJK") && e.text.includes("INVOICE"));
  } finally {
    store.db.close();
  }
});

test("without a CJK font, Chinese PDFs are refused instead of printing empty boxes", async () => {
  const { store, draft } = setup();
  try {
    const d = draft({ language: "zh" });
    store.cjkFont = () => null;
    await assert.rejects(renderPdf(store.document(d.id)), (e) => e.status === 409 && /Chinese font/.test(e.message));
    // A Chinese client name on an English document still renders, as before.
    const c2 = store.saveClient({ name: "陈氏贸易", email: "x@y.co" });
    const en = draft({ client_id: c2.id });
    assert.ok((await renderPdf(store.document(en.id))).length > 1000);
  } finally {
    store.db.close();
  }
});

test("TrueType collections are opened by their PostScript names", () => {
  // Minimal collection header with two fonts whose name tables hold PostScript names.
  const font = (name) => {
    const str = Buffer.from(name, "utf16le").swap16();
    const b = Buffer.alloc(12 + 16 + 6 + 12 + str.length);
    b.writeUInt16BE(1, 4);
    b.write("name", 12, "latin1");
    b.writeUInt32BE(28, 20);
    b.writeUInt16BE(1, 30);
    b.writeUInt16BE(18, 32);
    b.writeUInt16BE(3, 34);
    b.writeUInt16BE(6, 40);
    b.writeUInt16BE(str.length, 42);
    str.copy(b, 46);
    return b;
  };
  const a = font("NotoSansCJKjp-Regular"),
    c = font("NotoSansCJKsc-Regular");
  const head = Buffer.alloc(20);
  head.write("ttcf", 0, "latin1");
  head.writeUInt32BE(2, 8);
  head.writeUInt32BE(20, 12);
  head.writeUInt32BE(20 + a.length, 16);
  const shift = (b, by) => {
    b.writeUInt32BE(b.readUInt32BE(20) + by, 20);
    return b;
  };
  const ttc = Buffer.concat([head, shift(a, 20), shift(c, 20 + a.length)]);
  assert.deepEqual(collectionNames(ttc), ["NotoSansCJKjp-Regular", "NotoSansCJKsc-Regular"]);
  assert.equal(collectionNames(Buffer.from("not a font at all")), null);
});

test("PDF template: layouts, accent, show/hide options, footer text and custom logo", async () => {
  const { store, draft } = setup();
  try {
    assert.throws(() => store.saveSettings({ pdfAccent: "red" }), /colour/);
    assert.throws(() => store.saveSettings({ pdfLayout: "fancy" }), /layout/);
    assert.throws(() => store.setLogo({ name: "x.gif", data: Buffer.from("GIF89a" + "0".repeat(20)) }), /PNG|type/);
    const logo = store.setLogo({ name: "brand.png", data: PNG_1PX });
    store.saveSettings({
      pdfLayout: "modern",
      pdfAccent: "#aa3300",
      pdfShowBank: false,
      pdfShowTerms: false,
      pdfShowBuyerTax: false,
      pdfFooterText: "Meranti Sdn Bhd",
      customFields: [{ label: "Project", show: "pdf" }, { label: "Cost centre", show: "internal" }],
    });
    const [project, cost] = store.settings().customFields;
    const d = store.issue(draft({ notes: "Thanks", custom: { [project.id]: "PRJ-7", [cost.id]: "SECRET-CC" } }).id);
    assert.equal(store.settings().pdfAccent, "#AA3300");
    const r = await capture(() => renderPdf(store.document(d.id)));
    assert.ok(Buffer.isBuffer(r.images[0]) && r.images[0].equals(PNG_1PX), "business logo replaces Nawlogic");
    assert.ok(!r.text.includes("Payment information") && !r.text.includes("Terms"));
    assert.ok(r.text.includes("Notes"));
    assert.ok(!r.all.includes("C1234567890"), "buyer tax IDs hidden");
    assert.match(r.all, /Project: PRJ-7/);
    assert.ok(!r.all.includes("SECRET-CC"), "internal fields never reach the PDF");
    assert.match(r.all, /Meranti Sdn Bhd \| Not a validated MyInvois e-Invoice/);
    // The logo snapshot stays on issued documents even after the logo changes.
    store.clearLogo();
    assert.ok(store.logoFor(store.document(d.id).business).data.equals(PNG_1PX));
    assert.equal(store.logoFor(store.settings()), null);
    assert.ok(logo.id);
    for (const layout of ["classic", "compact", "modern"]) {
      store.saveSettings({ pdfLayout: layout, pdfShowFooter: false });
      const x = await capture(() => renderPdf(store.document(draft().id)));
      assert.ok(x.pdf.length > 1000, layout);
      assert.ok(!x.all.includes("Not a validated"), "footer text hidden");
    }
  } finally {
    store.db.close();
  }
});

test("quotations show the deposit, invoices the instalment plan, lists the attachments", async () => {
  const { store, draft } = setup();
  try {
    const q = store.issue(draft({ kind: "quote", deposit: { type: "percent", value: "30" } }).id);
    const rq = await capture(() => renderPdf(store.document(q.id)));
    assert.ok(rq.text.includes("Deposit required"));
    assert.match(rq.all, /Deposit 30% on acceptance: RM\s?300\.00/);
    const d = store.issue(draft({ list_attachments: true }).id);
    store.addAttachment(d.id, { name: "site-photo.png", data: PNG_1PX, visibility: "client" });
    store.addAttachment(d.id, { name: "internal.png", data: PNG_1PX });
    store.setInstalments(d.id, [
      { due_date: addDays(today(), 10), amount: "400" },
      { due_date: addDays(today(), 40), amount: "600" },
    ]);
    const r = await capture(() => renderPdf(store.document(d.id)));
    assert.ok(r.text.includes("Instalment plan"));
    assert.match(r.all, /Next payment of RM\s?400\.00 is due on/);
    assert.match(r.all, /site-photo\.png/);
    assert.ok(!r.all.includes("internal.png"), "only client-visible attachments are listed");
  } finally {
    store.db.close();
  }
});

test("receipts, notes and statements use the template, language and currency", async () => {
  const { store, client, draft } = setup();
  try {
    store.saveClient({ ...client, language: "ms" }, client.id);
    store.saveSettings({ pdfAccent: "#112233" });
    const usd = store.issue(draft({ currency: "USD", fx_rate: "4.4", language: "ms" }).id);
    const myr = store.issue(draft().id);
    const p = store.recordPayment(usd.id, { amount: "100", paid_date: today(), method: "Cash", reference: "U-1" });
    const rr = await capture(() => renderReceiptPdf(store.receipt(p.receipt_id)));
    assert.ok(rr.text.includes("RESIT BAYARAN"));
    assert.match(rr.all, /US\$100\.00/);
    const s = store.statement(client.id, {});
    const rs = await capture(() => renderStatementPdf(s));
    assert.ok(rs.text.includes("PENYATA AKAUN"));
    assert.ok(rs.text.includes("MATA WANG: USD") && rs.text.includes("MATA WANG: MYR"));
    assert.match(rs.all, /US\$1,000\.00/);
    assert.ok(myr.total);
  } finally {
    store.db.close();
  }
});
