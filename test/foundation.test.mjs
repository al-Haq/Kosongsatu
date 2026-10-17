import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../server/migrate.mjs";
import { qrMatrix, qrSvg } from "../server/qr.mjs";
import { sniff } from "../server/files.mjs";
import { renderPdf } from "../server/pdf.mjs";
import { openDatabase } from "../server/db.mjs";
import { fixture, issuedInvoice, PNG_1PX, password } from "./helpers.mjs";

test("named migrations run once, in order, and roll back on failure", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE documents(id TEXT)");
  const list = [
    { name: "x-001", sql: "CREATE TABLE a(v INTEGER);" },
    { name: "x-002", up: (d) => d.exec("INSERT INTO a VALUES(1)") },
  ];
  assert.deepEqual(runMigrations(db, ":memory:", list), ["x-001", "x-002"]);
  assert.deepEqual(runMigrations(db, ":memory:", list), []);
  assert.throws(() =>
    runMigrations(db, ":memory:", [...list, { name: "x-003", sql: "INSERT INTO a VALUES(2); INSERT INTO missing VALUES(1);" }]),
  );
  assert.equal(db.prepare("SELECT count(*) n FROM a").get().n, 1, "failed migration rolled back");
  assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations").get().n, 2);
});

test("QR codes encode content as a module matrix and SVG", () => {
  const m = qrMatrix("https://myinvois.hasil.gov.my/abc/share/xyz");
  assert.ok(m.length >= 21 && m.every((r) => r.length === m.length));
  assert.ok(m[0][0] && m[0][6] && !m[1][1], "finder pattern present");
  assert.match(qrSvg("hello"), /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.throws(() => qrMatrix(""), /QR content/);
});

test("file types are decided by content, not by name", () => {
  assert.equal(sniff(PNG_1PX), "image/png");
  assert.equal(sniff(Buffer.from("%PDF-1.7 ...")), "application/pdf");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(sniff(Buffer.from("<html>")), null);
});

test("owners upload, list, download and delete files with safe headers", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const q = new URLSearchParams({ entity_type: "document", entity_id: invoice.id, purpose: "attachment", name: "photo.html" });
    const res = await f.auth("/api/files?" + q, "POST", new Uint8Array(PNG_1PX), { "Content-Type": "application/octet-stream" });
    assert.equal(res.status, 201);
    const meta = await res.json();
    assert.equal(meta.mime, "image/png");
    assert.equal(meta.name, "photo.png", "extension follows the real type");
    assert.equal(meta.data, undefined);
    const list = await f.json("/api/files?entity_type=document&entity_id=" + invoice.id);
    assert.equal(list.length, 1);
    const file = await f.auth("/api/files/" + meta.id);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.match(file.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_1PX);
    const bad = await f.auth("/api/files?" + q, "POST", new Uint8Array(Buffer.from("<script>alert(1)</script>")));
    assert.equal(bad.status, 415);
    assert.equal((await f.request("/api/files/" + meta.id)).status, 401, "owner only");
    assert.equal((await f.auth("/api/files/" + meta.id, "DELETE")).status, 200);
    assert.equal((await f.auth("/api/files/" + meta.id)).status, 404);
    const backup = await f.json("/api/backup");
    assert.ok(Array.isArray(backup.files) && backup.files.every((x) => !("data" in x)));
  } finally {
    await f.close();
  }
});

test("integration keys are encrypted, write-only and the environment wins", () => {
  const s = openDatabase(":memory:");
  s.setSecret("TEST_KEY", "very-secret");
  const raw = s.db.prepare("SELECT value FROM secrets WHERE name='TEST_KEY'").get().value;
  assert.ok(!Buffer.from(raw, "base64").toString().includes("very-secret"));
  assert.equal(s.secret("TEST_KEY"), "very-secret");
  assert.equal(s.config("TEST_KEY", {}), "very-secret");
  assert.equal(s.config("TEST_KEY", { TEST_KEY: "from-env" }), "from-env");
  assert.deepEqual(
    s.secretStatus(["TEST_KEY", "OTHER"], {}).map((x) => x.source),
    ["settings", null],
  );
  s.setSecret("TEST_KEY", null);
  assert.equal(s.secret("TEST_KEY"), null);
  assert.throws(() => s.setSecret("lower", "x"), /Invalid setting/);
});

test("audit entries feed event consumers from their own cursor", () => {
  const s = openDatabase(":memory:");
  s.audit("before.cursor", null);
  assert.deepEqual(s.auditSince("hooks"), [], "new consumers do not replay history");
  s.audit("one", "a");
  s.audit("two", "b");
  const rows = s.auditSince("hooks");
  assert.deepEqual(rows.map((r) => r.action), ["one", "two"]);
  s.ackAudit("hooks", rows[0].id);
  assert.deepEqual(s.auditSince("hooks").map((r) => r.action), ["two"]);
  assert.deepEqual(s.auditSince("other"), []);
});

test("document PDFs draw module blocks with QR codes and images", async () => {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "R", address: "A", email: "a@example.com" });
  const { invoice } = issuedInvoice(s);
  const plain = await renderPdf(invoice);
  const extended = await renderPdf(invoice, null, [
    { heading: "Scan to verify", qr: "https://example.com/verify/123", text: "Validated e-Invoice" },
    { heading: "Signature", image: PNG_1PX, imageWidth: 60, text: "Signed by Test" },
    { heading: "Note only", text: "Plain text block" },
  ]);
  assert.equal(extended.subarray(0, 5).toString(), "%PDF-");
  assert.ok(extended.length > plain.length);
  assert.deepEqual(await s.pdfBlocks(invoice), []);
});

test("guest pages serve the app shell; assets and API paths do not", async () => {
  const f = await fixture();
  try {
    for (const path of ["/portal/abc123", "/client/abc", "/reset/xyz-1"]) {
      const res = await f.request(path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /<div id="app">/);
    }
    assert.equal((await f.request("/portal/../server/db.mjs")).status, 404);
    assert.equal((await f.request("/ext/documents.mjs")).status, 200);
    assert.equal((await f.request("/ext/nothing.mjs")).status, 404);
  } finally {
    await f.close();
  }
});

test("integration key route requires the password and a declared key", async () => {
  const f = await fixture();
  try {
    const res = await f.auth("/api/secrets/NOT_DECLARED", "PUT", { value: "x", password });
    assert.equal(res.status, 404);
    const ws = await f.json("/api/workspace");
    assert.ok(Array.isArray(ws.secrets));
    assert.equal(typeof ws.ext, "object");
    assert.ok(Array.isArray(await f.json("/api/jobs")));
  } finally {
    await f.close();
  }
});

test("email log accepts module email kinds after the rebuild", () => {
  const s = openDatabase(":memory:");
  s.db
    .prepare("INSERT INTO email_log(id,kind,recipients,subject,status,created) VALUES('e1','notification','a@example.com','Hi','sent','2026-01-01')")
    .run();
  assert.equal(s.emailLog()[0].kind, "notification");
  assert.equal(s.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
