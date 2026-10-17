import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { openDatabase } from "../server/db.mjs";
import { parseCsv, runImport, templateCsv, TEMPLATES } from "../server/platform-import.mjs";
import { today, addDays } from "../server/domain.mjs";

const bytes = (s) => new Uint8Array(Buffer.from(s));
async function preview(f, kind, csv) {
  const res = await f.auth(`/api/platform/import/${kind}/preview`, "POST", bytes(csv), { "Content-Type": "text/csv" });
  return { status: res.status, body: await res.json() };
}
async function commit(f, kind, csv, sha) {
  const res = await f.auth(`/api/platform/import/${kind}?sha256=${sha}`, "POST", bytes(csv), { "Content-Type": "text/csv" });
  return { status: res.status, body: await res.json() };
}

test("CSV parsing: quotes, new lines, BOM and separators", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",2\n\n'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["multi\nline", "2"],
  ]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]], "semicolon (Excel in some locales)");
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]], "tab");
  assert.throws(() => parseCsv('a\n"open'), /not closed/);
  assert.throws(() => parseCsv("  "), /empty/);
});

test("templates download as CSV and import cleanly once their clients exist", async () => {
  const f = await fixture();
  try {
    for (const kind of ["clients", "services", "invoices"]) {
      const res = await f.auth(`/api/platform/import/template/${kind}.csv`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition"), new RegExp(`nawlogic-${kind}-template.csv`));
      const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
      assert.equal(body, templateCsv(kind));
      assert.equal(parseCsv(body)[0].join(","), TEMPLATES[kind][0].join(","));
    }
    assert.equal((await f.auth("/api/platform/import/template/secrets.csv")).status, 404);
    assert.equal((await f.request("/api/platform/import/template/clients.csv")).status, 401, "owner only");
    for (const kind of ["clients", "services", "invoices"]) {
      const csv = templateCsv(kind);
      const p = await preview(f, kind, csv);
      assert.equal(p.status, 200);
      assert.equal(p.body.errors, 0, JSON.stringify(p.body.results));
      const c = await commit(f, kind, csv, p.body.sha256);
      assert.equal(c.status, 201, JSON.stringify(c.body));
    }
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.platform.imports.length, 3);
  } finally {
    await f.close();
  }
});

test("clients: preview every row, skip existing names, refuse the whole file on any error", async () => {
  const f = await fixture();
  try {
    f.store.saveClient({ name: "Existing Sdn Bhd" });
    const good = "Client Name,E-mail,Payment Terms,Address\nNew One Sdn Bhd,one@example.com,30 days,\"Lot 1, Jalan 2\"\nexisting sdn bhd,x@example.com,14,\n";
    const p = await preview(f, "clients", good);
    assert.deepEqual(p.body.results.map((r) => [r.lines[0], r.status]), [[2, "ok"], [3, "skip"]]);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM clients").get().n, 1, "preview writes nothing");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'client.%'").get().n, 2, "preview leaves no audit");
    const bad = good + "Broken,not-an-email,14,\nNew One Sdn Bhd,dup@example.com,7,\n";
    const pb = await preview(f, "clients", bad);
    assert.equal(pb.body.errors, 2);
    assert.match(pb.body.results[2].message, /valid email/);
    assert.match(pb.body.results[3].message, /Same name as row 2/);
    const cb = await commit(f, "clients", bad, pb.body.sha256);
    assert.equal(cb.status, 422);
    assert.equal(cb.body.imported, false);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM clients").get().n, 1, "all or nothing");
    const cg = await commit(f, "clients", good, p.body.sha256);
    assert.equal(cg.status, 201);
    const c = f.store.db.prepare("SELECT * FROM clients WHERE name='New One Sdn Bhd'").get();
    assert.equal(c.terms, 30);
    assert.equal(c.address, "Lot 1, Jalan 2");
    // Importing the same file again creates nothing new.
    const again = await commit(f, "clients", good, p.body.sha256);
    assert.equal(again.status, 200);
    assert.equal(again.body.created, 0);
    // The file must be the one that was previewed.
    assert.equal((await commit(f, "clients", good + "Another,a@example.com,1,\n", p.body.sha256)).status, 409);
    assert.equal((await f.auth("/api/platform/import/clients", "POST", bytes(good))).status, 400, "preview first");
    assert.equal((await preview(f, "clients", "email\nx@example.com\n")).status, 400, "name column required");
    assert.equal((await preview(f, "widgets", "name\nx\n")).status, 404);
  } finally {
    await f.close();
  }
});

test("services import with rates and SST rules", async () => {
  const f = await fixture();
  try {
    const p = await preview(f, "services", "name,unit,price,sst rate\nSupport,Hour,\"RM1,200.50\",0\nTaxed,Month,100,8\nBad,Hour,abc,0\n");
    assert.deepEqual(p.body.results.map((r) => r.status), ["ok", "ok", "error"]);
    assert.match(p.body.results[2].message, /not an amount/);
    const ok = await preview(f, "services", "name,unit,rate\nSupport,Hour,\"RM1,200.50\"\n");
    await commit(f, "services", "name,unit,rate\nSupport,Hour,\"RM1,200.50\"\n", ok.body.sha256);
    assert.equal(f.store.db.prepare("SELECT rate FROM services WHERE name='Support'").get().rate, 120050);
  } finally {
    await f.close();
  }
});

test("historical invoices keep number, dates and status; paid amounts become imported receipts", async () => {
  const f = await fixture({ settings: { email: "", phone: "" } });
  try {
    const a = f.store.saveClient({ name: "ABC Sdn Bhd", email: "a@example.com" });
    f.store.saveClient({ name: "Meranti Digital" });
    const year = today().slice(0, 4);
    const old = addDays(today(), -60);
    const csv = [
      "number,client,issue_date,due_date,description,quantity,rate,tax_rate,status,paid_amount,paid_date,notes",
      `INV-${year}-0007,ABC Sdn Bhd,${old},${addDays(old, 30)},Network setup,1,2500.00,0,paid,,${addDays(old, 10)},`,
      `OLD/2024/15,ABC Sdn Bhd,${old},${addDays(old, 30)},Maintenance,1,750.00,0,partly paid,300.00,${addDays(old, 5)},`,
      `OLD/2024/15,,,,On-site support,2,200.00,0,,,,`,
      `OLD-16,Meranti Digital,${old.slice(8, 10)}/${old.slice(5, 7)}/${old.slice(0, 4)},,Consulting,10,"RM200",0,unpaid,,,Opening balance`,
      `OLD-17,Meranti Digital,${old},${old},Cancelled job,1,100.00,0,void,,,`,
    ].join("\n");
    const p = await preview(f, "invoices", csv);
    assert.equal(p.body.errors, 0, JSON.stringify(p.body.results));
    assert.equal(p.body.units, 4, "rows grouped by invoice number");
    assert.deepEqual(p.body.results[1].lines, [3, 4]);
    assert.match(p.body.results[0].summary, /Paid$/);
    assert.match(p.body.results[1].summary, /RM1150\.00 \/ Part-paid/);
    const before = { docs: f.store.db.prepare("SELECT count(*) n FROM documents").get().n, receipts: f.store.db.prepare("SELECT count(*) n FROM cash_receipts").get().n };
    assert.deepEqual(before, { docs: 0, receipts: 0 }, "preview writes nothing");
    const c = await commit(f, "invoices", csv, p.body.sha256);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const docs = f.store.documents();
    const by = Object.fromEntries(docs.map((d) => [d.number, d]));
    assert.equal(by[`INV-${year}-0007`].status, "Paid");
    assert.equal(by[`INV-${year}-0007`].issue_date, old);
    assert.equal(by["OLD/2024/15"].paid, 30000);
    assert.equal(by["OLD/2024/15"].balance, 85000);
    assert.equal(by["OLD/2024/15"].items.length, 2);
    assert.equal(by["OLD-16"].status, "Overdue", "due date defaults to the issue date and is in the past");
    assert.equal(by["OLD-16"].notes, "Opening balance");
    assert.equal(by["OLD-17"].status, "Void");
    assert.ok(docs.every((d) => d.client_snapshot && d.business_snapshot && !d.token_hash), "locked like issued documents, never shared");
    const receipts = f.store.receipts();
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.account === "IMPORTED" && /Imported/.test(r.note) && r.available === 0));
    assert.equal(receipts.find((r) => r.amount === 250000).paid_date, addDays(old, 10));
    assert.equal(f.store.statement(a.id, { from_date: addDays(old, -1), to_date: today() }).closing, 85000, "statement agrees");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM email_log").get().n, 0, "nothing emailed");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action IN ('document.issued','receipt.received','link.rotated')").get().n, 0, "no issue, receipt or share events");
    assert.ok(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action='import.invoice' AND actor LIKE 'import:owner:%'").get().n === 4);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM platform_import_records").get().n, 6);
    // Numbering continues after the imported series number.
    f.store.saveSettings({ email: "billing@example.com" });
    const d = f.store.saveDocument({ kind: "invoice", client_id: a.id, issue_date: today(), due_date: today(), items: [{ description: "New", quantity: 1, rate: "1.00" }] });
    assert.equal(f.store.issue(d.id).number, `INV-${year}-0008`);
    // Re-importing skips the numbers already present.
    const again = await preview(f, "invoices", csv);
    assert.deepEqual(again.body.results.map((r) => r.status), ["skip", "skip", "skip", "skip"]);
  } finally {
    await f.close();
  }
});

test("historical invoice validation", async () => {
  const s = openDatabase(":memory:");
  s.saveClient({ name: "ABC" });
  const head = "number,client,issue_date,due_date,description,quantity,rate,tax_rate,status,paid_amount,paid_date\n";
  const check = (row, pattern) => {
    const r = runImport(s, "invoices", head + row);
    assert.equal(r.results[0].status, "error", row);
    assert.match(r.results[0].message, pattern, row);
  };
  const past = addDays(today(), -10),
    future = addDays(today(), 10);
  check(`X-1,Nobody,${past},,Work,1,10,0,,,`, /Client "Nobody" not found/);
  check(`X-1,ABC,${future},,Work,1,10,0,,,`, /future issue date/);
  check(`X-1,ABC,31/02/2025,,Work,1,10,0,,,`, /not a date/);
  check(`X-1,ABC,${past},,Work,1,10,0,paid,5,`, /less than the total/);
  check(`X-1,ABC,${past},,Work,1,10,0,,50,`, /more than the invoice total/);
  check(`X-1,ABC,${past},,Work,1,10,0,unpaid,5,`, /unpaid but a paid amount/);
  check(`X-1,ABC,${past},,Work,1,10,0,void,5,`, /void invoice cannot/);
  check(`X-1,ABC,${past},,Work,1,10,0,maybe,,`, /not one of unpaid/);
  check(`X-1,ABC,${past},,Work,1,10,6,,,`, /SST registration number/);
  check(`X-1,ABC,${past},,Work,1,10,0,paid,,${future}`, /Paid date cannot be in the future/);
  check(`X 1,ABC,${past},,Work,1,10,0,,,`, /may only use/);
  check(`X-1,ABC,${past},${addDays(past, -1)},Work,1,10,0,,,`, /Due date must be on or after/);
  const conflict = runImport(s, "invoices", head + `X-2,ABC,${past},,A,1,10,0,,,\nX-2,ABC,${addDays(past, -1)},,B,1,10,0,,,`);
  assert.match(conflict.results[0].message, /issue date differs/);
  assert.throws(() => runImport(s, "invoices", "number,client\nX,ABC\n"), /needs a "issue_date" column/);
  assert.throws(() => runImport(s, "clients", "name\n" + "x\n".repeat(2001)), /up to 2000 rows/);
  assert.equal(s.db.prepare("SELECT count(*) n FROM documents").get().n, 0);
});
