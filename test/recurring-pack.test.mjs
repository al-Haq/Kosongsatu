import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { openDatabase } from "../server/db.mjs";
import { Mailer } from "../server/mailer.mjs";
import { today } from "../server/domain.mjs";
import { previousMonth } from "../server/recurring-dates.mjs";
import { packData, packCsv, packFiles, renderPackPdf, zip } from "../server/recurring-pack.mjs";
import { sendPack, runAccountantPack } from "../server/recurring-auto.mjs";

const month = previousMonth(today());
const day = (d) => `${month}-${String(d).padStart(2, "0")}`;
const before = previousMonth(day(1));
function setup({ mail = true } = {}) {
  const store = openDatabase(":memory:");
  store.saveSettings({
    registration: "TEST-001",
    address: "Test office",
    email: "billing@example.com",
    sstNumber: "W10-1808-31000001",
  });
  const sent = [];
  const transport = {
    async sendMail(m) {
      sent.push(m);
      return { messageId: "<pack@test>" };
    },
  };
  const mailer = new Mailer(store, { config: mail ? { from: "billing@example.com" } : null, transport: mail ? transport : null });
  return { store, sent, ctx: { store, mailer, appUrl: "https://app.example" } };
}
function books(store) {
  const a = store.saveClient({ name: "Alpha Sdn Bhd", tin: "C1234567890" });
  const b = store.saveClient({ name: "=SUM(1)" });
  const issue = (client, issued, due, rate, tax = 0, kind = "invoice") =>
    store.issue(
      store.saveDocument({
        kind,
        client_id: client.id,
        issue_date: issued,
        due_date: due,
        items: [{ description: "Work", quantity: 1, rate, tax_rate: tax }],
      }).id,
    );
  const inv = {
    a: issue(a, day(5), day(19), "1000.00", 8),
    old: issue(a, `${before}-10`, `${before}-24`, "300.00"),
    e: issue(a, day(10), day(24), "75.00"),
    b: issue(b, day(28), today(), "200.00"),
  };
  issue(a, day(6), day(20), "999.00", 0, "quote");
  store.void(inv.e.id, "Issued in error");
  store.recordPayment(inv.a.id, { amount: "500.00", paid_date: day(20), method: "Bank transfer", reference: "PAY-A" });
  store.adjustment(inv.a.id, { kind: "credit", amount: "100.00", reason: "Goodwill", issue_date: day(25) });
  const spare = store.receive({ client_id: a.id, amount: "50.00", paid_date: day(21), method: "Cash", reference: "CASH-1" });
  store.refund(spare.id, { amount: "20.00", paid_date: day(22), reference: "RF-BANK-1", reason: "Overpaid" });
  // Activity after the month ends never changes the month's pack.
  store.recordPayment(inv.b.id, { amount: "200.00", paid_date: today(), method: "Bank transfer", reference: "PAY-B" });
  return inv;
}

test("the pack lists the month's invoices, notes, cash, SST and aging at month end", () => {
  const { store } = setup();
  try {
    const inv = books(store);
    const p = packData(store, month);
    assert.deepEqual(
      p.invoices.map((i) => [i.number, i.status]),
      [
        [inv.a.number, "Issued"],
        [inv.e.number, "Void"],
        [inv.b.number, "Issued"],
      ],
    );
    assert.equal(p.totals.invoices, 2);
    assert.equal(p.totals.invoiced, 108000 + 20000);
    // The RM 100 credit note carries its share of the 8% SST (741 sen), so the
    // month's SST is 8000 - 741, the same figure as the SST-02 worksheet.
    assert.equal(p.totals.sst, 8000 - 741);
    assert.deepEqual(p.notes.map((n) => [n.kind, n.amount, n.invoice]), [["credit", 10000, inv.a.number]]);
    assert.equal(p.totals.net_invoiced, 128000 - 10000);
    assert.equal(p.totals.received, 50000 + 5000);
    assert.equal(p.totals.refunded, 2000);
    assert.equal(p.totals.net_cash, 53000);
    // The credit note's taxable share (9259) and SST (741) come off the 8% line.
    assert.deepEqual(p.sst.rates.map((r) => [r.rate, r.taxable, r.tax]), [[0, 20000, 0], [8, 100000 - 9259, 8000 - 741]]);
    // 30th/31st: A is 11+ days late, B is not yet due, the older invoice is 31-60 days late.
    assert.equal(p.aging.d30, 108000 - 10000 - 50000);
    assert.equal(p.aging.current, 20000);
    assert.equal(p.aging.d60, 30000);
    assert.equal(p.totals.outstanding, 48000 + 20000 + 30000);
    assert.equal(p.open.length, 3);
  } finally {
    store.db.close();
  }
});

test("CSV files neutralise formulas and carry notes, receipts, refunds and SST", async () => {
  const { store } = setup();
  try {
    books(store);
    const p = packData(store, month);
    const files = packCsv(p);
    const invoices = files.invoices.split("\r\n");
    assert.ok(files.invoices.startsWith("﻿"));
    assert.match(invoices[0], /"Type","Number","Date"/);
    assert.ok(invoices.some((l) => l.includes(`"'=SUM(1)"`)), "formula cells are prefixed");
    assert.ok(invoices.some((l) => /"Credit note".*"-100\.00","Goodwill"/.test(l)));
    assert.ok(files.receipts.includes(`"Refund"`) && files.receipts.includes(`"-20.00"`));
    assert.ok(files.receipts.includes(`"500.00"`));
    assert.match(files.sst, /"8","1000\.00","80\.00"/);
    const pdf = await renderPackPdf(p);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  } finally {
    store.db.close();
  }
});

test("the zip holds the PDF and three CSV files with valid checksums", async () => {
  const { store } = setup();
  try {
    books(store);
    const files = await packFiles(packData(store, month));
    const z = zip(files);
    const end = z.length - 22;
    assert.equal(z.readUInt32LE(end), 0x06054b50);
    assert.equal(z.readUInt16LE(end + 10), 4);
    const names = [];
    let at = z.readUInt32LE(end + 16);
    for (let i = 0; i < 4; i++) {
      assert.equal(z.readUInt32LE(at), 0x02014b50);
      const size = z.readUInt32LE(at + 24),
        len = z.readUInt16LE(at + 28),
        offset = z.readUInt32LE(at + 42),
        crc = z.readUInt32LE(at + 16);
      const name = z.subarray(at + 46, at + 46 + len).toString();
      names.push(name);
      const data = z.subarray(offset + 30 + len, offset + 30 + len + size);
      assert.equal(crc32(data) >>> 0, crc, name);
      assert.deepEqual(data, files[i].data);
      at += 46 + len;
    }
    assert.deepEqual(names, [
      `accountant-pack-${month}.pdf`,
      `invoices-${month}.csv`,
      `receipts-${month}.csv`,
      `sst-${month}.csv`,
    ]);
  } finally {
    store.db.close();
  }
});

test("the job emails last month's pack once, only on the chosen day or the 6 days after", async () => {
  const { store, sent, ctx } = setup();
  try {
    books(store);
    const thisMonth = today().slice(0, 7);
    assert.deepEqual(await runAccountantPack(ctx, { asOf: `${thisMonth}-03` }), { skipped: true, reason: "off" });
    assert.throws(() => store.saveRecurringConfig({ pack: { enabled: true, email: "" } }), /accountant's email/);
    store.saveRecurringConfig({ pack: { enabled: true, email: "accountant@firm.example", day: 3 } });
    assert.equal((await runAccountantPack(ctx, { asOf: `${thisMonth}-02` })).reason, "not the send day");
    const r = await runAccountantPack(ctx, { asOf: `${thisMonth}-04` });
    assert.deepEqual(r, { month, sent: true });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["accountant@firm.example"]);
    assert.deepEqual(
      sent[0].attachments.map((a) => a.filename),
      [`accountant-pack-${month}.pdf`, `invoices-${month}.csv`, `receipts-${month}.csv`, `sst-${month}.csv`],
    );
    assert.match(sent[0].text, /Invoices issued: 2/);
    assert.deepEqual(await runAccountantPack(ctx, { asOf: `${thisMonth}-05` }), { month, skipped: true });
    assert.equal((await runAccountantPack(ctx, { asOf: `${thisMonth}-10` })).reason, "not the send day");
    assert.equal(sent.length, 1);
    assert.equal(store.db.prepare("SELECT kind FROM email_log").get().kind, "accountant_pack");
    // "Send now" works for any past month, also one already sent.
    assert.deepEqual(await sendPack(ctx, month, { to: "partner@firm.example" }), { sent: true, month });
    assert.deepEqual(sent[1].to, ["partner@firm.example"]);
    await assert.rejects(sendPack(ctx, thisMonth), /month that has ended/);
    assert.equal(store.db.prepare("SELECT count(*) n FROM recurring_packs WHERE status='sent'").get().n, 2);
  } finally {
    store.db.close();
  }
});

test("a pack that cannot be sent is recorded once and not retried by the job", async () => {
  const { store, ctx } = setup({ mail: false });
  try {
    store.saveRecurringConfig({ pack: { enabled: true, email: "accountant@firm.example" } });
    const asOf = `${today().slice(0, 7)}-01`;
    const r = await runAccountantPack(ctx, { asOf });
    assert.equal(r.sent, false);
    assert.match(r.error, /Email is not configured/);
    assert.deepEqual(await runAccountantPack(ctx, { asOf }), { month, skipped: true });
    const log = store.db.prepare("SELECT * FROM recurring_packs").all();
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].status, log[0].source], ["failed", "auto"]);
    await assert.rejects(sendPack(ctx, month), /Email is not configured/);
    assert.equal(store.db.prepare("SELECT count(*) n FROM audit WHERE action='accountant_pack.failed'").get().n, 2);
  } finally {
    store.db.close();
  }
});
