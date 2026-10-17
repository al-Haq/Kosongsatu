import test from "node:test";
import assert from "node:assert/strict";
import { suggestMatches, numberPatterns, nameMatch } from "../server/payments-match.mjs";
import { parseRanking, aiPayload } from "../server/payments-ai.mjs";
import { fixture } from "./helpers.mjs";
import { today, addDays } from "../server/domain.mjs";

const inv = (number, client, balance, due = "2026-10-10", extra = {}) => ({
  id: "id-" + number,
  number,
  client_id: "c-" + client,
  client_name: client,
  balance,
  total: balance,
  issue_date: "2026-09-26",
  due_date: due,
  ...extra,
});
const INVOICES = [
  inv("INV-2026-0012", "Meranti Digital Sdn Bhd", 150000),
  inv("INV-2026-0013", "Meranti Digital Sdn Bhd", 80000),
  inv("INV-2026-0015", "Bayu Design Enterprise", 150000, "2026-11-30"),
  inv("INV-2026-0021", "Rimba Retail (M) Sdn Bhd", 45000),
  inv("INV-2026-0022", "Rimba Retail (M) Sdn Bhd", 30000),
  inv("INV-2026-0001", "Kedai Runcit Ah Seng", 150000, "2026-08-01"),
];
const bank = (reference, amount, description = "", txn_date = "2026-10-11") => ({ reference, description, amount, txn_date, account: "MAIN" });
const top = (t, data = { invoices: INVOICES }) => suggestMatches(t, data)[0];

test("invoice numbers are found even when banks and clients mangle them", () => {
  const p = numberPatterns("INV-2026-0012");
  for (const s of ["INV2026 12", "inv-2026-0012", "INV 2026/012", "IBG/INV20260012/MERANTI", "Ref:INV-2026-12."]) assert.match(s, p.full, s);
  assert.match("PYMT 2026-0012", p.digits);
  assert.match("PAYMENT INV12", p.short);
  for (const s of ["INV-2026-0120", "INV-2026-00123", "INV-2025-0012"]) assert.doesNotMatch(s, p.full, s);
  assert.doesNotMatch("17/10/2026 12:30", p.digits, "a date and time is not an invoice number");
  assert.doesNotMatch("INV-2026-0012", numberPatterns("INV-2026-0001").full);
  assert.deepEqual(nameMatch("Meranti Digital Sdn Bhd", "DUITNOW TRF MERANTI DIGI").found, ["MERANTI"]);
  assert.equal(nameMatch("Rimba Retail (M) Sdn Bhd", "RIMBARETAIL").share, 1, "glued words");
  assert.equal(nameMatch("Sdn Bhd", "anything").share, 0);
});

test("amount, mangled number and client name together give a high-confidence match", () => {
  const s = top(bank("IBG CREDIT", 150000, "MERANTI DIGITAL INV2026 12"));
  assert.equal(s.invoices[0].number, "INV-2026-0012");
  assert.equal(s.confidence, "High");
  assert.ok(s.score >= 90);
  assert.ok(s.reasons.some((r) => /open balance/.test(r)));
  assert.ok(s.reasons.some((r) => /appears as "INV2026 12"/.test(r)));
  assert.ok(s.reasons.some((r) => /Client name/.test(r)));
  assert.ok(s.reasons.some((r) => /day\(s\) after the due date/.test(r)));
  const lower = top(bank("inv-2026-0012", 150000));
  assert.equal(lower.invoices[0].number, "INV-2026-0012");
});

test("the client name breaks a tie between equal balances; no signal at all is flagged as a hard case", () => {
  const byName = suggestMatches(bank("DUITNOW TRF MERANTI DIGI", 150000), { invoices: INVOICES });
  assert.equal(byName[0].invoices[0].number, "INV-2026-0012");
  assert.ok(byName[0].score > byName[1].score + 8);
  const blind = suggestMatches(bank("CDM CASH DEPOSIT", 150000, "", "2026-11-20"), { invoices: INVOICES });
  assert.ok(blind.length >= 2);
  assert.ok(blind.every((s) => s.ambiguous && s.confidence !== "High"), "hard case for the owner (or the AI)");
});

test("part payments, several invoices paid together and nothing-to-say transfers", () => {
  const part = top(bank("MERANTI PART PAYMENT INV12", 50000));
  assert.equal(part.invoices[0].number, "INV-2026-0012");
  assert.equal(part.invoices[0].allocate, 50000);
  assert.ok(part.reasons.some((r) => /part payment/.test(r)));
  const both = top(bank("RIMBA RETAIL INV 21 22", 75000));
  assert.equal(both.kind, "invoices");
  assert.deepEqual(both.invoices.map((i) => i.number), ["INV-2026-0021", "INV-2026-0022"]);
  assert.match(both.reasons[0], /INV-2026-0021 \+ INV-2026-0022/);
  assert.deepEqual(suggestMatches(bank("SALARY OCT", 123456), { invoices: INVOICES }), []);
  // More than the balance needs a number; the rest stays as customer funds.
  const over = top(bank("INV-2026-0013 MERANTI", 90000));
  assert.equal(over.invoices[0].allocate, 80000);
  assert.ok(over.reasons.some((r) => /customer funds/.test(r)));
  const early = suggestMatches(bank("INV-2026-0012", 150000, "", "2026-09-01"), { invoices: INVOICES })[0];
  assert.ok(early.reasons.includes("Paid before the invoice was issued"));
});

test("a recorded receipt and a client's submitted reference are strong signals", () => {
  const receipts = [{ id: "r1", number: "RC-2026-00004", amount: 150000, account: "MAIN", reference: "MBB778899", client_id: "c-Meranti Digital Sdn Bhd", client_name: "Meranti Digital Sdn Bhd", paid_date: "2026-10-11" }];
  const r = top(bank("IBG MBB778899", 150000), { invoices: INVOICES, receipts });
  assert.equal(r.kind, "receipt");
  assert.equal(r.receipt_id, "r1");
  assert.equal(r.confidence, "High");
  const proofs = [{ id: "p1", invoice_id: "id-INV-2026-0015", reference: "CIMB-445566" }];
  const p = top(bank("INSTANT TRF CIMB445566", 150000), { invoices: INVOICES, proofs });
  assert.equal(p.invoices[0].number, "INV-2026-0015");
  assert.equal(p.proof_id, "p1");
  assert.ok(p.reasons.some((x) => /submitted reference "CIMB-445566"/.test(x)));
});

test("AI ranking sends only the minimum and only trusts known candidates", () => {
  const t = bank("CDM CASH DEPOSIT", 150000, "AH SENG KEDAI");
  const { list, payload } = aiPayload(t, INVOICES.slice(0, 3));
  assert.deepEqual(Object.keys(payload.candidates[0]).sort(), ["balance_myr", "client", "due", "id", "invoice"]);
  assert.ok(!JSON.stringify(payload).includes("id-INV"), "no record ids");
  const ranking = parseRanking('Sure! ```json\n{"ranking":[{"id":"c2","confidence":180,"reason":"Name"},{"id":"c9","confidence":50},{"id":"c2"}]}\n```', list);
  assert.deepEqual(ranking, [{ invoice_id: "id-INV-2026-0013", number: "INV-2026-0013", client_name: "Meranti Digital Sdn Bhd", confidence: 100, reason: "Name" }]);
  assert.throws(() => parseRanking("I think c1", list), /ranking/);
});

async function bankFixture(app = {}) {
  const f = await fixture({ app });
  const s = f.store;
  const meranti = s.saveClient({ name: "Meranti Digital Sdn Bhd", email: "ap@meranti.example" });
  const bayu = s.saveClient({ name: "Bayu Design", email: "finance@bayu.example" });
  const make = (client, rate) =>
    s.issue(s.saveDocument({ kind: "invoice", client_id: client.id, issue_date: today(), due_date: addDays(today(), 7), items: [{ description: "Work", quantity: 1, rate }] }).id);
  const a = make(meranti, "1500.00"),
    b = make(meranti, "800.00"),
    c = make(bayu, "1500.00");
  const compactNo = a.number.replace(/-0+/, "").replace("-", "");
  s.importBankRows([
    { account: "MAIN", txn_date: today(), reference: "IBG CREDIT", description: `MERANTI DIGI ${compactNo}`, amount: 150000, dedupe_key: "k1" },
    { account: "MAIN", txn_date: today(), reference: "CDM CASH DEPOSIT", description: "", amount: 150000, dedupe_key: "k2" },
    { account: "MAIN", txn_date: today(), reference: "MERANTI 2 INVOICES", description: "", amount: 230000, dedupe_key: "k3" },
  ]);
  const txn = (ref) => s.finance().bankTransactions.find((t) => t.reference === ref);
  return { ...f, meranti, bayu, a, b, c, txn };
}

test("one click records the bank receipt and allocates it through the normal ledger", async () => {
  const f = await bankFixture();
  try {
    const t = f.txn("IBG CREDIT");
    const ws = await f.json("/api/workspace");
    const s = ws.ext.payments.suggestions[t.id][0];
    assert.equal(s.invoices[0].id, f.a.id);
    assert.equal(s.confidence, "High");
    const combo = ws.ext.payments.suggestions[f.txn("MERANTI 2 INVOICES").id][0];
    assert.deepEqual(combo.invoices.map((i) => i.id).sort(), [f.a.id, f.b.id].sort());
    const res = await f.json(`/api/payments/bank/${t.id}/apply`, "POST", { allocations: [{ invoice_id: f.a.id, amount: "1500.00" }] });
    assert.equal(res.amount, 150000);
    assert.equal(res.allocated, 150000);
    assert.equal(res.method, "Bank transfer");
    assert.equal(f.store.document(f.a.id).status, "Paid");
    assert.equal(f.store.finance().bankTransactions.find((x) => x.id === t.id).receipt_id, res.id);
    assert.equal((await f.auth(`/api/payments/bank/${t.id}/apply`, "POST", { allocations: [{ invoice_id: f.a.id, amount: "1.00" }] })).status, 409, "only once");
    const cash = f.txn("CDM CASH DEPOSIT");
    const tooMuch = await f.auth(`/api/payments/bank/${cash.id}/apply`, "POST", { allocations: [{ invoice_id: f.b.id, amount: "800.00" }, { invoice_id: f.c.id, amount: "700.00" }] });
    assert.equal(tooMuch.status, 400, "invoices of two clients");
    const over = await f.auth(`/api/payments/bank/${cash.id}/apply`, "POST", { allocations: [{ invoice_id: f.c.id, amount: "1600.00" }] });
    assert.equal(over.status, 400);
    assert.equal(f.store.receipts().length, 1, "failed attempts record nothing");
    // A part allocation leaves the rest as customer funds.
    const part = await f.json(`/api/payments/bank/${cash.id}/apply`, "POST", { allocations: [{ invoice_id: f.c.id, amount: "1000.00" }] });
    assert.equal(part.available, 50000);
    assert.equal(f.store.document(f.c.id).balance, 50000);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='bank.suggestion.applied'").get());
  } finally {
    await f.close();
  }
});

test("an existing receipt is matched instead of recorded twice, and a submitted reference is confirmed", async () => {
  const f = await bankFixture();
  try {
    const t = f.txn("CDM CASH DEPOSIT");
    const r = f.store.receive({ client_id: f.bayu.id, amount: "1500.00", paid_date: today(), method: "Bank transfer", account: "MAIN", reference: "CDM-1" });
    const s = (await f.json("/api/workspace")).ext.payments.suggestions[t.id].find((x) => x.kind === "receipt");
    assert.equal(s.receipt_id, r.id);
    await f.json(`/api/payments/bank/${t.id}/apply`, "POST", { receipt_id: r.id });
    assert.equal(f.store.receipts().length, 1);
    assert.equal(f.store.finance().bankTransactions.find((x) => x.id === t.id).receipt_id, r.id);
    const { token } = f.store.share(f.b.id);
    const proof = f.store.proof(token, { reference: "MERANTI 2 INVOICES" });
    const combo = f.txn("MERANTI 2 INVOICES");
    const got = (await f.json("/api/workspace")).ext.payments.suggestions[combo.id][0];
    assert.equal(got.proof_id, proof.id);
    await f.json(`/api/payments/bank/${combo.id}/apply`, "POST", {
      allocations: got.invoices.map((i) => ({ invoice_id: i.id, amount: (i.allocate / 100).toFixed(2) })),
      proof_id: got.proof_id,
    });
    assert.equal(f.store.document(f.b.id).proofs[0].status, "confirmed");
    assert.equal(f.store.document(f.a.id).status, "Paid");
  } finally {
    await f.close();
  }
});

test("asking the AI model is an explicit owner action with minimal data", async () => {
  const sent = [];
  const aiFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const candidates = JSON.parse(JSON.parse(init.body).messages[1].content).candidates;
    const pick = candidates.find((c) => c.client === "Bayu Design");
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ranking: [{ id: pick.id, confidence: 72, reason: "Deposit near the due date" }, { id: "c99", confidence: 99 }] }) } }] }) };
  };
  const f = await bankFixture({ assistantConfig: { base: "https://ai.example/v1", model: "local-model", key: "k" }, aiFetch });
  try {
    const t = f.txn("CDM CASH DEPOSIT");
    assert.equal((await f.auth(`/api/payments/bank/${t.id}/ai`, "POST", {})).status, 400, "consent required");
    const out = await f.json(`/api/payments/bank/${t.id}/ai`, "POST", { consent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://ai.example/v1/chat/completions");
    const body = JSON.stringify(sent[0].body);
    for (const secret of ["ap@meranti.example", "finance@bayu.example", f.a.id, f.c.id]) assert.ok(!body.includes(secret), "not sent: " + secret);
    assert.deepEqual(out.ranking.map((x) => [x.invoice_id, x.confidence]), [[f.c.id, 72]]);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.payments.ai, true);
    assert.equal(ws.ext.payments.hints[t.id].ranking[0].invoice_id, f.c.id);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='bank.ai.ranked' AND detail LIKE '%https://ai.example%'").get());
  } finally {
    await f.close();
  }
  const off = await bankFixture();
  try {
    assert.equal((await off.auth(`/api/payments/bank/${off.txn("CDM CASH DEPOSIT").id}/ai`, "POST", { consent: true })).status, 503);
  } finally {
    await off.close();
  }
});
