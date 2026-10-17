import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { today } from "../server/domain.mjs";
import { verifyDocument } from "../server/tax-ubl.mjs";
import tax from "../server/ext/tax.mjs";
import { fixture } from "./helpers.mjs";
import { configure, fakeMyInvois, invoice, readyBusiness, readyClient, selfSignedCert } from "./tax-helpers.mjs";

async function setup({ env = "sandbox", signing = null, mode = "valid" } = {}) {
  const f = await fixture();
  readyBusiness(f.store);
  configure(f.store, { env, signing });
  const fake = fakeMyInvois({ mode });
  const svc = f.server.ctx.services.tax;
  svc.api.fetch = fake.fetch;
  svc.einvoices.pollDelay = 0;
  return { ...f, fake, svc };
}
const submissions = (fake) => fake.calls.filter((c) => c.path === "/api/v1.0/documentsubmissions/");
const submit = (f, body) => f.auth("/api/tax/einvoices", "POST", body);
const lastDoc = (fake) => submissions(fake).at(-1).documents[0];

test("an issued invoice is submitted, validated and gets a validation QR on the PDF and client page", async () => {
  const f = await setup();
  try {
    const c = readyClient(f.store);
    const d = invoice(f.store, c, { discount: "175.00" });
    const res = await submit(f, { source: "invoice", id: d.id });
    assert.equal(res.status, 201);
    const e = await res.json();
    assert.equal(e.state, "valid");
    assert.equal(e.type_code, "01");
    assert.equal(e.version, "1.0");
    assert.match(e.url, new RegExp(`^https://preprod\\.myinvois\\.hasil\\.gov\\.my/${e.uuid}/share/LONG`));
    assert.ok(e.cancel_until > new Date().toISOString());
    // Taxpayer login with client credentials.
    const login = f.fake.calls.find((x) => x.path === "/connect/token");
    const form = new URLSearchParams(login.body);
    assert.deepEqual([form.get("grant_type"), form.get("scope"), form.get("client_id"), form.get("client_secret")], ["client_credentials", "InvoicingAPI", "client-id", "client-secret"]);
    // The submitted document.
    const sent = lastDoc(f.fake);
    assert.equal(sent.codeNumber, d.number);
    assert.equal(sent.documentHash, createHash("sha256").update(Buffer.from(sent.document, "base64")).digest("hex"));
    const inv = sent.json.Invoice[0];
    assert.deepEqual(inv.InvoiceTypeCode, [{ _: "01", listVersionID: "1.0" }]);
    assert.equal(inv.AccountingCustomerParty[0].Party[0].PartyIdentification[0].ID[0]._, "C1234567890");
    assert.equal(inv.AccountingCustomerParty[0].Party[0].Contact[0].Telephone[0]._, "+60123456789");
    assert.equal(inv.AccountingSupplierParty[0].Party[0].PartyIdentification[2].ID[0]._, "W10-1808-32000001");
    assert.deepEqual(inv.InvoiceLine.map((l) => l.TaxTotal[0].TaxSubtotal[0].TaxCategory[0].ID[0]._), ["02", "01", "06"]);
    assert.deepEqual(inv.InvoiceLine.map((l) => l.Item[0].CommodityClassification[0].ItemClassificationCode[0]._), ["022", "022", "022"]);
    assert.equal(inv.LegalMonetaryTotal[0].PayableAmount[0]._, d.total / 100);
    assert.equal(inv.TaxTotal[0].TaxAmount[0]._, d.tax / 100);
    assert.equal(inv.InvoiceLine[0].AllowanceCharge[0].Amount[0]._, 100, "line share of the discount");
    // PDF block, footer and client page.
    const blocks = await f.store.pdfBlocks(f.store.document(d.id));
    const qr = blocks.find((b) => b.qr);
    assert.equal(qr.qr, e.url);
    assert.match(qr.footer, /Validated MyInvois e-Invoice/);
    assert.match(qr.text, /SANDBOX/);
    const pdf = await f.auth(`/api/documents/${d.id}/pdf`);
    assert.equal(pdf.status, 200);
    const link = await f.json(`/api/documents/${d.id}/share`, "POST", { days: 3 });
    const pub = await (await f.request("/api/public/" + link.url.split("/client/")[1])).json();
    assert.equal(pub.ext.tax.einvoice.url, e.url);
    assert.match(pub.ext.tax.einvoice.qr, /^data:image\/svg\+xml;base64,/);
    assert.equal(JSON.stringify(pub).includes("client-secret"), false);
    // At most one active e-Invoice per invoice.
    const again = await submit(f, { source: "invoice", id: d.id });
    assert.equal(again.status, 409);
    assert.equal(submissions(f.fake).length, 1);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='einvoice.validated' AND entity_id=?").get(d.id));
    // A validated e-Invoice blocks voiding.
    const v = await f.auth(`/api/documents/${d.id}/void`, "POST", { reason: "Mistake" });
    assert.equal(v.status, 409);
    assert.match((await v.json()).error, /Cancel the e-Invoice first/);
  } finally {
    await f.close();
  }
});

test("with a certificate the document is signed as version 1.1 and verifies", async () => {
  const cert = selfSignedCert({ cn: "Nawlogic e-Invoice", org: "NAWLOGIC" });
  const f = await setup({ signing: cert });
  try {
    const d = invoice(f.store, readyClient(f.store));
    const e = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(e.version, "1.1");
    const raw = Buffer.from(lastDoc(f.fake).document, "base64").toString("utf8");
    assert.equal(verifyDocument(raw).valid, true);
    assert.equal(JSON.parse(raw).Invoice[0].InvoiceTypeCode[0].listVersionID, "1.1");
    const t = await f.json("/api/tax/test", "POST", {});
    assert.equal(t.version, "1.1");
    assert.match(t.signing.subject, /CN=Nawlogic e-Invoice/);
    // A mismatched key is caught before anything is sent.
    f.store.setSecret("MYINVOIS_SIGNING_KEY", selfSignedCert().keyPem);
    const d2 = invoice(f.store, readyClient(f.store));
    const r = await submit(f, { source: "invoice", id: d2.id });
    assert.equal(r.status, 409);
    assert.equal(submissions(f.fake).length, 1);
  } finally {
    await f.close();
  }
});

test("missing details block submission and are listed for the owner", async () => {
  const f = await setup();
  try {
    const c = f.store.saveClient({ name: "Bare client" });
    const d = invoice(f.store, c);
    const r = await submit(f, { source: "invoice", id: d.id });
    assert.equal(r.status, 409);
    const msg = (await r.json()).error;
    assert.match(msg, /Buyer TIN/);
    assert.match(msg, /Buyer ID type/);
    assert.match(msg, /Buyer postcode/);
    assert.equal(submissions(f.fake).length, 0);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.tax.ready[d.id].ready, false);
    assert.ok(ws.ext.tax.ready[d.id].missing.includes("Buyer phone"));
    assert.equal(JSON.stringify(ws).includes("client-secret"), false);
    assert.equal(ws.ext.tax.status.configured, true);
    // Without keys, nothing can be submitted.
    f.store.setSecret("MYINVOIS_CLIENT_SECRET", null);
    const r2 = await submit(f, { source: "invoice", id: invoice(f.store, readyClient(f.store)).id });
    assert.equal(r2.status, 409);
    assert.match((await r2.json()).error, /client ID and client secret/);
    assert.equal((await f.request("/api/tax/einvoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  } finally {
    await f.close();
  }
});

test("invalid and rejected documents keep MyInvois' errors and can be submitted again", async () => {
  const f = await setup({ mode: "invalid" });
  try {
    const d = invoice(f.store, readyClient(f.store));
    const bad = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(bad.state, "invalid");
    assert.equal(bad.errors[0].code, "CF404");
    assert.match(bad.errors[0].message, /Buyer TIN not found/);
    f.fake.state.mode = "reject";
    const rej = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(rej.state, "rejected");
    assert.equal(rej.errors.some((x) => x.code === "CF321"), true);
    f.fake.state.mode = "badstructure";
    const bs = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(bs.state, "rejected");
    assert.match(bs.errors.map((x) => x.message).join(" "), /Invoice line missing/);
    f.fake.state.mode = "valid";
    const ok = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(ok.state, "valid");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM tax_einvoices WHERE source_id=?").get(d.id).n, 4);
  } finally {
    await f.close();
  }
});

test("a lost response is reconciled with MyInvois instead of being sent twice", async () => {
  const f = await setup({ mode: "lost" });
  try {
    const d = invoice(f.store, readyClient(f.store));
    const e = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(e.state, "unknown");
    assert.equal((await submit(f, { source: "invoice", id: d.id })).status, 409, "no second submission while unknown");
    f.fake.state.mode = "valid";
    for (const x of f.fake.docs.values()) Object.assign(x, { status: "Valid", longId: "LONGFOUND" });
    f.store.db.prepare("UPDATE tax_einvoices SET next_check=?").run(new Date(Date.now() - 1000).toISOString());
    const run = await f.json("/api/jobs/tax:einvoice/run", "POST", {});
    assert.equal(run.checked, 1);
    const row = f.store.db.prepare("SELECT * FROM tax_einvoices WHERE source_id=?").get(d.id);
    assert.equal(row.state, "valid");
    assert.equal(row.long_id, "LONGFOUND");
    assert.equal(submissions(f.fake).length, 1);
  } finally {
    await f.close();
  }
});

test("a submission that never arrived is released after 15 minutes", async () => {
  const f = await setup({ mode: "network" });
  try {
    const d = invoice(f.store, readyClient(f.store));
    const e = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal(e.state, "unknown");
    const old = new Date(Date.now() - 20 * 60000).toISOString();
    f.store.db.prepare("UPDATE tax_einvoices SET submitted_at=?,next_check=?").run(old, old);
    await f.json("/api/jobs/tax:einvoice/run", "POST", {});
    assert.equal(f.store.db.prepare("SELECT state FROM tax_einvoices").get().state, "failed");
    f.fake.state.mode = "valid";
    assert.equal((await (await submit(f, { source: "invoice", id: d.id })).json()).state, "valid");
  } finally {
    await f.close();
  }
});

test("a validated e-Invoice can be cancelled within 72 hours with a reason", async () => {
  const f = await setup();
  try {
    const d = invoice(f.store, readyClient(f.store));
    const e = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.equal((await f.auth(`/api/tax/einvoices/${e.id}/cancel`, "POST", { reason: "" })).status, 400);
    const out = await f.json(`/api/tax/einvoices/${e.id}/cancel`, "POST", { reason: "Wrong buyer details" });
    assert.equal(out.state, "cancelled");
    const put = f.fake.calls.find((x) => x.method === "PUT");
    assert.equal(put.path, `/api/v1.0/documents/state/${e.uuid}/state`);
    assert.deepEqual(put.json, { status: "cancelled", reason: "Wrong buyer details" });
    // Once cancelled the invoice can be voided or submitted again.
    const d2 = invoice(f.store, readyClient(f.store));
    const e2 = await (await submit(f, { source: "invoice", id: d2.id })).json();
    f.store.db.prepare("UPDATE tax_einvoices SET validated_at=? WHERE id=?").run(new Date(Date.now() - 73 * 3600000).toISOString(), e2.id);
    const late = await f.auth(`/api/tax/einvoices/${e2.id}/cancel`, "POST", { reason: "Too late" });
    assert.equal(late.status, 409);
    assert.match((await late.json()).error, /72-hour/);
    assert.equal((await f.auth(`/api/documents/${d.id}/void`, "POST", { reason: "Cancelled e-Invoice" })).status, 200);
  } finally {
    await f.close();
  }
});

test("credit and debit notes become e-Invoice types 02 and 03 referencing the original UUID", async () => {
  const f = await setup();
  try {
    const d = invoice(f.store, readyClient(f.store));
    const a = f.store.adjustment(d.id, { kind: "credit", amount: "108.00", reason: "Fewer hours", tax_lines_from: [0] });
    const early = await submit(f, { source: "credit", id: a.id });
    assert.equal(early.status, 409);
    assert.match((await early.json()).error, /original invoice/);
    const inv = await (await submit(f, { source: "invoice", id: d.id })).json();
    const cn = await (await submit(f, { source: "credit", id: a.id })).json();
    assert.equal(cn.type_code, "02");
    assert.equal(cn.state, "valid");
    const doc = lastDoc(f.fake).json.Invoice[0];
    assert.deepEqual(doc.BillingReference[0].InvoiceDocumentReference[0], { ID: [{ _: d.number }], UUID: [{ _: inv.uuid }] });
    assert.equal(doc.InvoiceLine.length, 1);
    assert.equal(doc.InvoiceLine[0].TaxTotal[0].TaxSubtotal[0].TaxAmount[0]._, 8);
    assert.equal(doc.LegalMonetaryTotal[0].PayableAmount[0]._, 108);
    const dn = f.store.adjustment(d.id, { kind: "debit", amount: "50.00", reason: "Extra part", tax_lines_from: [1] });
    const de = await (await submit(f, { source: "debit", id: dn.id })).json();
    assert.equal(de.type_code, "03");
    assert.equal(lastDoc(f.fake).json.Invoice[0].InvoiceLine[0].TaxTotal[0].TaxSubtotal[0].TaxCategory[0].ID[0]._, "01");
    // The note PDF carries the note's own QR code.
    const row = f.store.db.prepare("SELECT * FROM adjustments WHERE id=?").get(a.id);
    const blocks = await f.store.pdfBlocks({ ...f.store.document(d.id), kind: "credit", number: row.number, note: row });
    assert.equal(blocks.find((b) => b.qr).qr, cn.url);
    assert.equal((await f.auth(`/api/adjustments/${a.id}/pdf`)).status, 200);
  } finally {
    await f.close();
  }
});

test("a refund note becomes type 04 referencing the related invoice", async () => {
  const f = await setup();
  try {
    const c = readyClient(f.store);
    const d = invoice(f.store, c, { items: [{ description: "Work", quantity: "1", rate: "100.00" }] });
    await submit(f, { source: "invoice", id: d.id });
    f.store.recordPayment(d.id, { amount: "100.00", paid_date: today(), method: "Bank transfer", reference: "TT-1" });
    f.store.adjustment(d.id, { kind: "credit", amount: "40.00", reason: "Scope cut" });
    const receipt = f.store.receipts()[0];
    const refund = f.store.refund(receipt.id, { amount: "40.00", paid_date: today(), reference: "RF-TT-1", reason: "Return of credit" });
    const other = invoice(f.store, readyClient(f.store));
    assert.equal((await submit(f, { source: "refund", id: refund.id, invoice_id: other.id })).status, 400);
    assert.equal((await submit(f, { source: "refund", id: refund.id })).status, 400, "the invoice must be chosen");
    const e = await (await submit(f, { source: "refund", id: refund.id, invoice_id: d.id })).json();
    assert.equal(e.type_code, "04");
    const doc = lastDoc(f.fake).json.Invoice[0];
    assert.equal(doc.BillingReference[0].InvoiceDocumentReference[0].ID[0]._, d.number);
    assert.equal(doc.LegalMonetaryTotal[0].PayableAmount[0]._, 40);
    assert.equal(f.store.db.prepare("SELECT reference_id FROM tax_refund_refs WHERE refund_id=?").get(refund.id).reference_id, d.id);
  } finally {
    await f.close();
  }
});

test("automatic submission is opt-in, queued once and sent once", async () => {
  const f = await setup();
  try {
    const c = readyClient(f.store);
    const d1 = invoice(f.store, c);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM tax_einvoices").get().n, 0, "off by default");
    await f.json("/api/tax/settings", "PUT", { autoSubmit: true });
    const d2 = invoice(f.store, c);
    const queued = f.store.db.prepare("SELECT * FROM tax_einvoices WHERE source_id=?").get(d2.id);
    assert.equal(queued.state, "queued");
    assert.equal(queued.dedupe_key, `auto:invoice:${d2.id}`);
    await Promise.all([f.json("/api/jobs/tax:einvoice/run", "POST", {}), f.json("/api/jobs/tax:einvoice/run", "POST", {})]);
    await f.json("/api/jobs/tax:einvoice/run", "POST", {});
    assert.equal(submissions(f.fake).length, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM tax_einvoices WHERE source_id=?").get(d2.id).state, "valid");
    // A note on a validated invoice is queued too.
    const a = f.store.adjustment(d2.id, { kind: "credit", amount: "10.00", reason: "Rounding" });
    assert.equal(f.store.db.prepare("SELECT state FROM tax_einvoices WHERE source_id=?").get(a.id).state, "queued");
    // Consolidated-mode clients are reported monthly instead.
    const b2c = readyClient(f.store, { tax_einvoice: "consolidate" });
    const d3 = invoice(f.store, b2c);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM tax_einvoices WHERE source_id=?").get(d3.id).n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM tax_einvoices WHERE source_id=?").get(d1.id).n, 0);
    // A restored copy never resends.
    tax.onRestore(f.store.db);
    assert.equal(f.store.db.prepare("SELECT state FROM tax_einvoices WHERE source_id=?").get(a.id).state, "unknown");
    assert.equal(JSON.parse(f.store.db.prepare("SELECT data FROM tax_settings").get().data).autoSubmit, false);
  } finally {
    await f.close();
  }
});

test("sign-in problems surface as clear errors without signing the owner out", async () => {
  const f = await setup();
  try {
    f.fake.state.tokenStatus = 400;
    const r = await f.auth("/api/tax/test", "POST", {});
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /did not accept the client ID/);
    f.fake.state.tokenStatus = 200;
    assert.equal((await f.json("/api/tax/test", "POST", {})).env, "sandbox");
    assert.deepEqual(await f.json("/api/tax/validate-tin", "POST", { tin: "C25845632020", id_type: "BRN", id_value: "202001012345" }), { valid: true });
    assert.deepEqual(await f.json("/api/tax/validate-tin", "POST", { tin: "C99999999990", id_type: "BRN", id_value: "202001012345" }), { valid: false });
    assert.equal((await f.auth("/api/tax/validate-tin", "POST", { tin: "C1", id_type: "XX", id_value: "1" })).status, 400);
    // The cached token is reused.
    const logins = f.fake.state.logins;
    await f.json("/api/tax/validate-tin", "POST", { tin: "C25845632020", id_type: "BRN", id_value: "202001012345" });
    assert.equal(f.fake.state.logins, logins);
  } finally {
    await f.close();
  }
});

test("production keys use the production API and portal hosts", async () => {
  const f = await setup({ env: "production" });
  try {
    const d = invoice(f.store, readyClient(f.store));
    const e = await (await submit(f, { source: "invoice", id: d.id })).json();
    assert.ok(f.fake.calls.every((x) => x.host === "api.myinvois.hasil.gov.my"));
    assert.match(e.url, /^https:\/\/myinvois\.hasil\.gov\.my\//);
    const blocks = await f.store.pdfBlocks(f.store.document(d.id));
    assert.doesNotMatch(blocks.find((b) => b.qr).text, /SANDBOX/);
    const detail = await f.json(`/api/tax/einvoices/${e.id}`);
    assert.equal(detail.payload.Invoice[0].ID[0]._, d.number);
  } finally {
    await f.close();
  }
});
