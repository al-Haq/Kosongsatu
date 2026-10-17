import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { addMonths, taxSettings, thresholdMonitor, toMyr, TAX_DEFAULTS } from "../server/tax-sst.mjs";
import { readiness, supplierGaps, lineClasses } from "../server/tax-myinvois.mjs";
import { validTin, validIdNumber, normalizePhone } from "../server/tax-codes.mjs";
import { fixture } from "./helpers.mjs";
import { configure, fakeMyInvois, invoice, readyBusiness, readyClient } from "./tax-helpers.mjs";

test("code checks accept LHDN formats and reject the rest", () => {
  assert.ok(validTin("C25845632020"));
  assert.ok(validTin("IG12345678901"));
  assert.ok(validTin("EI00000000010"));
  assert.ok(!validTin("12345"));
  assert.ok(!validTin("C123"));
  assert.ok(validIdNumber("BRN", "202001012345"));
  assert.ok(validIdNumber("NRIC", "900101-14-5678"));
  assert.ok(!validIdNumber("NRIC", "9001"));
  assert.ok(validIdNumber("PASSPORT", "A12345678"));
  assert.equal(normalizePhone("03-1234 5678"), "+60312345678");
  assert.equal(normalizePhone("60123456789"), "+60123456789");
  assert.equal(normalizePhone("0065 6123 4567"), "+6561234567");
});

test("readiness lists everything an invoice still needs for MyInvois", () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "TEST-1", address: "Office", email: "t@example.com" });
    const gaps = supplierGaps(s);
    for (const g of ["Your business TIN", "Your registration number", "Your MSIC code", "Your business activity", "Your business phone", "Your business address lines", "Your business state"])
      assert.ok(gaps.some((x) => x.startsWith(g)), g);
    readyBusiness(s);
    assert.deepEqual(supplierGaps(s), []);
    const c = s.saveClient({ name: "Partial", tin: "C1234567890" });
    const d = invoice(s, c, { items: [{ description: "Work", quantity: "1", rate: "100.00" }] });
    const r = readiness(s, d);
    assert.equal(r.ready, false);
    assert.equal(r.mode, "individual");
    assert.deepEqual(r.missing, ["Buyer ID type and number (BRN, NRIC, passport or army)", "Buyer phone", "Buyer address lines", "Buyer city", "Buyer postcode (5 digits)", "Buyer state"]);
    const ok = invoice(s, readyClient(s));
    assert.deepEqual(readiness(s, ok), { ready: true, mode: "individual", missing: [] });
    // Without a default classification each line needs one.
    s.db.prepare("UPDATE tax_settings SET data=?").run(JSON.stringify({ ...taxSettings(s), defaultClass: "" }));
    assert.deepEqual(readiness(s, ok).missing, ["Classification for line 1", "Classification for line 2", "Classification for line 3"]);
    // A foreign buyer: state "Not applicable", no postcode check.
    const foreign = readyClient(s, { tin: "EI00000000020", tax_id_type: "PASSPORT", brn: "K1234567", tax_country: "SGP", tax_state: "17", tax_postcode: "", phone: "+6561234567" });
    s.db.prepare("UPDATE tax_settings SET data=?").run(JSON.stringify({ ...taxSettings(s), defaultClass: "022" }));
    assert.equal(readiness(s, invoice(s, foreign)).ready, true);
    assert.equal(readiness(s, { ...d, kind: "quote" }), null);
  } finally {
    s.db.close();
  }
});

test("classification comes from the line, the service default, the document default, then the business default", async () => {
  const f = await fixture();
  try {
    readyBusiness(f.store);
    const svc = f.store.saveService({ name: "Managed maintenance", rate: "750.00", unit: "Month" });
    assert.equal((await f.auth(`/api/tax/services/${svc.id}`, "PUT", { tax_class: "999" })).status, 400);
    await f.json(`/api/tax/services/${svc.id}`, "PUT", { tax_class: "030" });
    const c = readyClient(f.store);
    const draft = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      tax_class: "017",
      items: [
        { description: "Managed maintenance", quantity: "1", rate: "750.00" },
        { description: "Internet line", quantity: "1", rate: "120.00" },
      ],
    });
    assert.deepEqual(lineClasses(f.store, f.store.document(draft.id)).map((x) => [x.code, x.source]), [["030", "service"], ["017", "document"]]);
    assert.equal((await f.auth("/api/documents", "POST", { kind: "invoice", client_id: c.id, issue_date: today(), due_date: today(), tax_class: "999", items: [{ description: "x", quantity: "1", rate: "1.00" }] })).status, 400);
    const set = await f.json(`/api/tax/documents/${draft.id}/classes`, "PUT", { lines: { 1: "022" } });
    assert.deepEqual(set.lines.map((x) => x.code), ["030", "022"]);
    assert.equal((await f.auth(`/api/tax/documents/${draft.id}/classes`, "PUT", { lines: { 5: "022" } })).status, 400);
    assert.equal((await f.auth(`/api/tax/documents/${draft.id}/classes`, "PUT", { lines: { 0: "abc" } })).status, 400);
    // Classifications lock once the e-Invoice is submitted.
    configure(f.store);
    const fake = fakeMyInvois();
    f.server.ctx.services.tax.api.fetch = fake.fetch;
    f.server.ctx.services.tax.einvoices.pollDelay = 0;
    await f.json(`/api/documents/${draft.id}/issue`, "POST", {});
    await f.json("/api/tax/einvoices", "POST", { source: "invoice", id: draft.id });
    const sent = fake.calls.find((x) => x.documents).documents[0].json.Invoice[0];
    assert.deepEqual(sent.InvoiceLine.map((l) => l.Item[0].CommodityClassification[0].ItemClassificationCode[0]._), ["030", "022"]);
    assert.equal(sent.InvoiceLine[0].InvoicedQuantity[0].unitCode, undefined, "unit codes only when the line carries a unit");
    assert.equal((await f.auth(`/api/tax/documents/${draft.id}/classes`, "PUT", { lines: { 0: "022" } })).status, 409);
    // Deleting a draft removes its tax metadata too.
    const other = await f.json("/api/documents", "POST", { kind: "invoice", client_id: c.id, issue_date: today(), due_date: today(), tax_class: "022", items: [{ description: "x", quantity: "1", rate: "1.00" }] });
    assert.equal((await f.auth(`/api/documents/${other.id}`, "DELETE")).status, 200);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM tax_doc_meta WHERE document_id=?").get(other.id).n, 0);
  } finally {
    await f.close();
  }
});

test("the threshold monitor sums 12 months of net sales and warns at 80% and 100%", () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "TEST-1", address: "Office", email: "t@example.com" });
    const c = s.saveClient({ name: "Big client" });
    const big = (rate, day) => invoice(s, c, { issue_date: day, items: [{ description: "Project", quantity: "1", rate }] });
    big("99999.99", addMonths(today(), -14)); // outside the window
    const first = addMonths(today(), -5);
    for (let i = 0; i < 4; i++) big("99999.99", first);
    const set = { ...TAX_DEFAULTS };
    let m = thresholdMonitor(s, set);
    assert.equal(m.total, 4 * 9999999);
    assert.equal(m.sst.percent, 79);
    assert.equal(m.sst.level, "ok");
    const d = big("10000.00", addMonths(today(), -1));
    m = thresholdMonitor(s, set);
    assert.equal(m.sst.level, "near");
    assert.equal(m.sst.crossed, null);
    s.adjustment(d.id, { kind: "credit", amount: "5000.00", reason: "Scope cut" });
    assert.equal(thresholdMonitor(s, set).total, 4 * 9999999 + 500000, "credit notes reduce sales");
    big("99999.99", today());
    m = thresholdMonitor(s, set);
    assert.equal(m.sst.level, "over");
    assert.equal(m.sst.crossed, today().slice(0, 7));
    assert.equal(m.einvoice.threshold, 300000000);
    assert.equal(m.einvoice.level, "ok");
    assert.equal(m.history.length, 12);
    assert.equal(m.sst.registered, false);
    assert.equal(toMyr(10000, "4.25"), 42500);
    assert.equal(toMyr(333, "0.333333"), 111);
    assert.equal(toMyr(100, "1"), 100);
  } finally {
    s.db.close();
  }
});

test("the workspace carries the tax overview for the screens", async () => {
  const f = await fixture();
  try {
    const ws = await f.json("/api/workspace");
    const t = ws.ext.tax;
    for (const k of ["settings", "status", "codes", "supplierGaps", "einvoices", "ready", "classes", "consolidated", "candidates", "selfbilled", "thresholds", "exemptions", "periods"]) assert.ok(k in t, k);
    assert.equal(t.status.configured, false);
    assert.equal(t.codes.states["14"], "Wilayah Persekutuan Kuala Lumpur");
    assert.ok(ws.secrets.some((x) => x.name === "MYINVOIS_CLIENT_SECRET" && x.plugin === "tax"));
    const codes = await f.json("/api/tax/codes");
    assert.ok(codes.allMsic.includes("62010"));
    assert.ok(codes.allCountries.includes("MYS"));
    const backup = await f.json("/api/backup");
    assert.ok(backup.ext.tax.settings);
  } finally {
    await f.close();
  }
});
