import test from "node:test";
import assert from "node:assert/strict";
import { crc16, parseEmv, validateDuitNow } from "../server/payments-duitnow.mjs";
import { openDatabase } from "../server/db.mjs";
import { renderPdf } from "../server/pdf.mjs";
import { fixture, issuedInvoice, PNG_1PX } from "./helpers.mjs";

const tlv = (id, value) => id + String(value.length).padStart(2, "0") + value;
const withCrc = (body) => body + "6304" + crc16(body + "6304");
// A static DuitNow merchant QR as a Malaysian bank would issue it.
const body = (extra = "", init = "11") =>
  "000201" +
  tlv("01", init) +
  tlv("26", tlv("00", "A0000006150001") + tlv("01", "890123") + tlv("02", "0012345678")) +
  tlv("52", "7372") +
  tlv("53", "458") +
  extra +
  tlv("58", "MY") +
  tlv("59", "NAWLOGIC SYSTEMS") +
  tlv("60", "KUALA LUMPUR");
const STATIC = withCrc(body());

test("CRC-16/CCITT-FALSE matches the standard check value", () => {
  assert.equal(crc16("123456789"), "29B1");
});

test("a static DuitNow payload is accepted with its merchant details", () => {
  const v = validateDuitNow("  " + STATIC.slice(0, -4) + STATIC.slice(-4).toLowerCase() + "\n");
  assert.equal(v.payload, STATIC, "trimmed, checksum normalised");
  assert.equal(v.merchant, "NAWLOGIC SYSTEMS");
  assert.equal(v.city, "KUALA LUMPUR");
  assert.equal(v.duitnow, true);
  assert.equal(parseEmv(STATIC).at(-1).id, "63");
});

test("broken, dynamic, fixed-amount and foreign QR payloads are refused", () => {
  assert.throws(() => validateDuitNow(STATIC.slice(0, -1) + (STATIC.at(-1) === "0" ? "1" : "0")), /checksum does not match/);
  assert.throws(() => validateDuitNow(STATIC.slice(0, 40)), /cut short|checksum|structure/);
  assert.throws(() => validateDuitNow(withCrc(body("", "12"))), /dynamic/);
  assert.throws(() => validateDuitNow(withCrc(body(tlv("54", "150.00")))), /fixed amount/);
  assert.throws(() => validateDuitNow(withCrc(body().replace("5303458", "5303840"))), /ringgit/);
  assert.throws(() => validateDuitNow(withCrc(body().replace("000201", "000202"))), /EMVCo/);
  assert.throws(() => validateDuitNow("hello world this is not a qr payload at all"), /structure|EMVCo/);
  assert.throws(() => validateDuitNow(body()), /checksum/);
});

test("the QR prints on unpaid invoice PDFs with the invoice number as the reference", async () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "R-1", address: "KL", email: "a@example.com" });
    const { invoice } = issuedInvoice(s, { rate: "120.00" });
    assert.deepEqual(await s.pdfBlocks(invoice), [], "nothing until a QR is saved");
    s.saveDuitnow(STATIC);
    const blocks = await s.pdfBlocks(s.document(invoice.id));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].qr, STATIC);
    assert.match(blocks[0].text, new RegExp(invoice.number));
    assert.match(blocks[0].text, /RM\s?120\.00/);
    const pdf = await renderPdf(s.document(invoice.id), null, blocks);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    s.recordPayment(invoice.id, { amount: "120.00", paid_date: s.workspace().today, method: "Bank transfer", reference: "X1" });
    assert.deepEqual(await s.pdfBlocks(s.document(invoice.id)), [], "paid invoices do not ask for payment");
    const draft = s.saveDocument({ kind: "invoice", client_id: invoice.client_id, issue_date: invoice.issue_date, due_date: invoice.due_date, items: [{ description: "x", quantity: 1, rate: "5" }] });
    assert.deepEqual(await s.pdfBlocks(draft), []);
    // An uploaded bank image replaces the pasted text and prints as an image.
    s.saveDuitnowImage(PNG_1PX, "qr.png");
    const { invoice: other } = issuedInvoice(s);
    const img = await s.pdfBlocks(other);
    assert.ok(Buffer.isBuffer(img[0].image));
    assert.equal(s.duitnow().payload, null);
    assert.ok((await renderPdf(other, null, img)).length > 1000);
  } finally {
    s.db.close();
  }
});

test("owners save or upload the QR; client links show it only while payment is due", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const { token } = f.store.share(invoice.id);
    const bad = await f.auth("/api/payments/duitnow", "PUT", { payload: STATIC.slice(0, -2) + "00" });
    assert.equal(bad.status, 400);
    const saved = await f.json("/api/payments/duitnow", "PUT", { payload: STATIC });
    assert.match(saved.qr, /^data:image\/svg\+xml;base64,/);
    assert.equal((await f.json("/api/workspace")).ext.payments.duitnow.merchant, "NAWLOGIC SYSTEMS");
    let page = await (await f.request("/api/public/" + token)).json();
    assert.match(page.ext.payments.duitnow.qr, /^data:image\/svg/);
    assert.equal(page.ext.payments.duitnow.image, false);
    const pdf = await f.request(`/api/public/${token}/pdf`);
    assert.equal(pdf.status, 200);
    // Upload the bank's QR image instead (PNG/JPEG only, so it can go on the PDF).
    const notImage = await f.auth("/api/payments/duitnow/image?name=qr.pdf", "POST", new Uint8Array(Buffer.from("%PDF-1.4 x")));
    assert.equal(notImage.status, 415);
    const up = await f.auth("/api/payments/duitnow/image?name=qr.png", "POST", new Uint8Array(PNG_1PX));
    assert.equal(up.status, 201);
    page = await (await f.request("/api/public/" + token)).json();
    assert.equal(page.ext.payments.duitnow.image, true);
    const img = await f.request("/api/guest/payments/duitnow/" + token);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal((await f.request("/api/guest/payments/duitnow/" + "x".repeat(43))).status, 404);
    f.store.recordPayment(invoice.id, { amount: "100.00", paid_date: f.store.workspace().today, method: "Bank transfer", reference: "P1" });
    assert.equal((await f.request("/api/guest/payments/duitnow/" + token)).status, 404, "hidden once paid");
    assert.equal((await (await f.request("/api/public/" + token)).json()).ext.payments.duitnow, null);
    assert.equal((await f.json("/api/payments/duitnow/image", "DELETE")), null);
    assert.equal((await f.json("/api/workspace")).ext.payments.duitnow, null);
  } finally {
    await f.close();
  }
});
