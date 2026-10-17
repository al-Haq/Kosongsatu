import test from "node:test";
import assert from "node:assert/strict";
import { today } from "../server/domain.mjs";
import { addMonths } from "../server/tax-sst.mjs";
import { fixture } from "./helpers.mjs";
import { configure, fakeMyInvois, invoice, readyBusiness, readyClient } from "./tax-helpers.mjs";

async function setup() {
  const f = await fixture();
  readyBusiness(f.store);
  configure(f.store);
  const fake = fakeMyInvois();
  f.server.ctx.services.tax.api.fetch = fake.fetch;
  f.server.ctx.services.tax.einvoices.pollDelay = 0;
  return { ...f, fake };
}
const lastMonth = addMonths(today(), -1).slice(0, 7);
const lastDoc = (fake) => fake.calls.filter((c) => c.path === "/api/v1.0/documentsubmissions/").at(-1).documents[0].json.Invoice[0];

test("B2C invoices of a month become one consolidated e-Invoice for the general public", async () => {
  const f = await setup();
  try {
    const b2c = f.store.saveClient({ name: "Walk-in customer", tax_fields: "1", tax_einvoice: "consolidate" });
    const day = lastMonth + "-10";
    const small1 = invoice(f.store, b2c, { issue_date: day, items: [{ description: "Laptop repair", quantity: "1", rate: "250.00", tax_rate: 8 }] });
    const small2 = invoice(f.store, b2c, { issue_date: day, items: [{ description: "Setup", quantity: "1", rate: "100.00" }] });
    const big = invoice(f.store, b2c, { issue_date: day, items: [{ description: "Server", quantity: "1", rate: "12000.00" }] });
    // A USD invoice is consolidated at its own rate: USD 100 at 4.5 = RM 450.
    const usd = f.store.issue(
      f.store.saveDocument({ kind: "invoice", client_id: b2c.id, issue_date: day, due_date: day, currency: "USD", fx_rate: "4.5", items: [{ description: "Remote support", quantity: "1", rate: "100.00" }] }).id,
    );
    // Consolidated-mode invoices are not submitted one by one.
    const single = await f.auth("/api/tax/einvoices", "POST", { source: "invoice", id: small1.id });
    assert.equal(single.status, 409);
    assert.match((await single.json()).error, /consolidated/);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.tax.ready[small1.id].mode, "consolidated");
    assert.equal(ws.ext.tax.ready[small1.id].ready, true, "no buyer details needed");
    assert.match(ws.ext.tax.ready[big.id].missing.join(";"), /Over RM10,000/);
    const c = await f.json(`/api/tax/consolidated?month=${lastMonth}`);
    assert.deepEqual(c.ready.map((x) => x.number).sort(), [small1.number, small2.number, usd.number].sort());
    assert.deepEqual(c.tooLarge.map((x) => x.number), [big.number]);
    assert.equal(c.closed, true);
    assert.match(c.deadline, /^\d{4}-\d{2}-07$/);
    const thisMonth = await f.auth("/api/tax/consolidated", "POST", { month: today().slice(0, 7) });
    assert.equal(thisMonth.status, 409);
    const con = await f.json("/api/tax/consolidated", "POST", { month: lastMonth });
    assert.equal(con.number, `CON-${lastMonth}-01`);
    assert.equal(con.count, 3);
    assert.equal((await f.auth("/api/tax/consolidated", "POST", { month: lastMonth })).status, 409, "nothing left to consolidate");
    const e = await f.json("/api/tax/einvoices", "POST", { source: "consolidated", id: con.id });
    assert.equal(e.state, "valid");
    const doc = lastDoc(f.fake);
    const buyer = doc.AccountingCustomerParty[0].Party[0];
    assert.equal(buyer.PartyIdentification[0].ID[0]._, "EI00000000010");
    assert.equal(buyer.PartyLegalEntity[0].RegistrationName[0]._, "General Public");
    assert.ok(doc.InvoiceLine.every((l) => l.Item[0].CommodityClassification[0].ItemClassificationCode[0]._ === "004"));
    assert.equal(doc.InvoiceLine.length, 3);
    assert.deepEqual(doc.DocumentCurrencyCode, [{ _: "MYR" }]);
    const usdLine = doc.InvoiceLine.find((l) => l.Item[0].Description[0]._.includes(usd.number));
    assert.match(usdLine.Item[0].Description[0]._, /USD at 4\.5/);
    assert.equal(usdLine.LineExtensionAmount[0]._, 450);
    assert.equal(doc.LegalMonetaryTotal[0].PayableAmount[0]._, (small1.total + small2.total) / 100 + 450);
    // The invoice PDF says where it was reported; a note references the consolidated UUID.
    const blocks = await f.store.pdfBlocks(f.store.document(small1.id));
    assert.match(blocks.at(-1).text, new RegExp(con.number));
    const a = f.store.adjustment(small1.id, { kind: "credit", amount: "27.00", reason: "Partial refund" });
    const note = await f.json("/api/tax/einvoices", "POST", { source: "credit", id: a.id });
    assert.equal(note.state, "valid");
    const nd = lastDoc(f.fake);
    assert.equal(nd.BillingReference[0].InvoiceDocumentReference[0].UUID[0]._, e.uuid);
    assert.equal(nd.AccountingCustomerParty[0].Party[0].PartyIdentification[0].ID[0]._, "EI00000000010");
    // A validated consolidation is kept.
    assert.equal((await f.auth(`/api/tax/consolidated/${con.id}`, "DELETE")).status, 409);
  } finally {
    await f.close();
  }
});

test("an unsubmitted consolidation can be deleted and rebuilt", async () => {
  const f = await setup();
  try {
    const b2c = f.store.saveClient({ name: "Walk-in", tax_fields: "1", tax_einvoice: "consolidate" });
    invoice(f.store, b2c, { issue_date: lastMonth + "-02", items: [{ description: "Fix", quantity: "1", rate: "80.00" }] });
    const con = await f.json("/api/tax/consolidated", "POST", { month: lastMonth });
    assert.equal((await f.auth(`/api/tax/consolidated/${con.id}`, "DELETE")).status, 200);
    const again = await f.json("/api/tax/consolidated", "POST", { month: lastMonth });
    assert.equal(again.count, 1);
    assert.equal(again.number, `CON-${lastMonth}-01`);
    assert.equal((await f.auth("/api/tax/consolidated", "POST", { month: "2026-1" })).status, 400);
  } finally {
    await f.close();
  }
});

const foreignSeller = {
  name: "Cloud Hosting Pte Ltd",
  tin: "EI00000000030",
  id_type: "BRN",
  id_value: "NA",
  phone: "+6561234567",
  email: "billing@cloud.example",
  address: "1 Raffles Place",
  city: "Singapore",
  postcode: "048616",
  state: "17",
  country: "SGP",
};

test("self-billed e-Invoices are created from a simple form and submitted with the seller as supplier", async () => {
  const f = await setup();
  try {
    const bad = await f.auth("/api/tax/selfbilled", "POST", { supplier: { ...foreignSeller, tin: "123" }, lines: [{ description: "Hosting", quantity: "1", rate: "500.00", class: "035" }] });
    assert.equal(bad.status, 400);
    assert.equal((await f.auth("/api/tax/selfbilled", "POST", { supplier: foreignSeller, lines: [{ description: "Hosting", quantity: "1", rate: "500.00", class: "999" }] })).status, 400);
    assert.equal((await f.auth("/api/tax/selfbilled", "POST", { supplier: { ...foreignSeller, country: "MYS", state: "14", postcode: "" }, lines: [{ description: "x", quantity: "1", rate: "1.00", class: "036" }] })).status, 400);
    const sb = await f.json("/api/tax/selfbilled", "POST", {
      supplier: foreignSeller,
      issue_date: today(),
      currency: "USD",
      fx_rate: "4.2",
      lines: [{ description: "Cloud hosting October", quantity: "1", rate: "500.00", class: "035" }],
      notes: "Imported service",
    });
    assert.match(sb.number, /^SB-\d{4}-00001$/);
    assert.equal(sb.total, 50000);
    const e = await f.json("/api/tax/einvoices", "POST", { source: "selfbilled", id: sb.id });
    assert.equal(e.type_code, "11");
    const doc = lastDoc(f.fake);
    assert.equal(doc.AccountingSupplierParty[0].Party[0].PartyIdentification[0].ID[0]._, "EI00000000030");
    assert.equal(doc.AccountingSupplierParty[0].Party[0].IndustryClassificationCode[0]._, "00000");
    assert.equal(doc.AccountingCustomerParty[0].Party[0].PartyIdentification[0].ID[0]._, "C25845632020");
    assert.deepEqual(doc.DocumentCurrencyCode, [{ _: "USD" }]);
    assert.deepEqual(doc.TaxExchangeRate[0].CalculationRate, [{ _: 4.2 }]);
    // A self-billed credit note references the original.
    const cn = await f.json("/api/tax/selfbilled", "POST", { type_code: "12", ref_id: sb.id, supplier: foreignSeller, lines: [{ description: "Service credit", quantity: "1", rate: "50.00", class: "035" }] });
    const ce = await f.json("/api/tax/einvoices", "POST", { source: "selfbilled", id: cn.id });
    assert.equal(ce.type_code, "12");
    assert.equal(lastDoc(f.fake).BillingReference[0].InvoiceDocumentReference[0].UUID[0]._, e.uuid);
    assert.equal((await f.auth("/api/tax/selfbilled", "POST", { type_code: "12", ref_id: "nope", supplier: foreignSeller, lines: [{ description: "x", quantity: "1", rate: "1.00", class: "035" }] })).status, 400);
    const pdf = await f.auth(`/api/tax/selfbilled/${sb.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.tax.selfbilled.length, 2);
    assert.equal(ws.ext.tax.selfbilled.find((x) => x.id === sb.id).einvoice.state, "valid");
  } finally {
    await f.close();
  }
});
