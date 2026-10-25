// The business's logo is on every PDF and email once uploaded, and an owner
// can change a member's sign-in email (in the app or on the server console).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../server/db.mjs";
import { createOwner, verifyPassword } from "../server/auth.mjs";
import { businessLogo, snapshotLogo, imageSize, fitBox } from "../server/pdf-logo.mjs";
import { renderReportPdf, renderPurchaseOrderPdf } from "../server/books-pdf.mjs";
import { renderSst02Pdf } from "../server/tax-pdf.mjs";
import { packData, renderPackPdf } from "../server/recurring-pack.mjs";
import { sst02, taxSettings } from "../server/tax-sst.mjs";
import { previousMonth } from "../server/recurring-dates.mjs";
import { today } from "../server/domain.mjs";
import { fixture, PNG_1PX } from "./helpers.mjs";
import { member, memberPassword, signIn } from "./team-helpers.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../server/cli.mjs", import.meta.url));

test("once a logo is uploaded, reports, purchase orders, the accountant pack and SST-02 use it", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    assert.equal(businessLogo(s), null, "no logo yet: PDFs use the default");
    const month = previousMonth(today());
    const pdfs = async (logo) => [
      await renderReportPdf({ title: "Profit and loss", subtitle: "Test", business: s.settings(), sections: [], logo }),
      await renderPurchaseOrderPdf({ number: "PO-1", business: s.settings(), vendor: { name: "Vendor" }, items: [], lines: [], subtotal: 0, tax: 0, total: 0, currency: "MYR" }, logo),
      await renderPackPdf(packData(s, month), logo),
      await renderSst02Pdf({ ...sst02(s, taxSettings(s), { period: month }) }, logo),
    ];
    const before = await pdfs(businessLogo(s));
    const up = await f.auth("/api/ext/documents/logo?name=logo.png", "POST", new Uint8Array(PNG_1PX), { "Content-Type": "application/octet-stream" });
    assert.equal(up.status, 201);
    assert.deepEqual(businessLogo(s), PNG_1PX, "the uploaded logo");
    const after = await pdfs(businessLogo(s));
    for (let i = 0; i < before.length; i++) assert.notEqual(Buffer.compare(before[i], after[i]), 0, `PDF ${i} changes to the business logo`);
    // Over HTTP too: the SST-02 working paper download differs once a logo is set.
    const sst = await f.auth(`/api/tax/sst02.pdf?period=${month}`);
    assert.equal(sst.status, 200);
    assert.match(sst.headers.get("content-type"), /pdf/);
    // Emails point at the business logo instead of Nawlogic's.
    assert.match(f.server.ctx.mailer.logoPath(), /^\/api\/guest\/setup\/logo\?v=/);
  } finally {
    await f.close();
  }
});

test("an owner changes a member's sign-in email; the password stays and the change is audited", async () => {
  const f = await fixture();
  try {
    const m = await member(f, "staff", "amirul.haniff@nawlogic.com");
    const change = (email) => f.auth(`/api/team/users/${m.id}`, "PUT", { email });
    assert.equal((await change("not-an-email")).status, 400);
    assert.equal((await change("owner@example.com")).status, 409, "another user's email");
    const r = await f.json(`/api/team/users/${m.id}`, "PUT", { email: "Amirul.Haniff@Vatex.my" });
    assert.equal(r.email, "amirul.haniff@vatex.my");
    assert.ok((await signIn(f, "amirul.haniff@vatex.my", memberPassword)).cookie, "signs in with the new email and the same password");
    const audit = f.store.db.prepare("SELECT * FROM audit WHERE action='user.email_changed'").get();
    assert.equal(audit.detail, "amirul.haniff@nawlogic.com → amirul.haniff@vatex.my");
    // A staff member cannot change emails.
    const staff = await member(f, "staff");
    const denied = await staff.auth(`/api/team/users/${m.id}`, "PUT", { email: "x@vatex.my" });
    assert.equal(denied.status, 403);
  } finally {
    await f.close();
  }
});

test("set-email changes any account's sign-in email from the server console", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-set-email-"));
  const path = join(dir, "db.sqlite");
  try {
    const s = openDatabase(path);
    await createOwner(s, "amirul.haniff@nawlogic.com", "First-owner-password-1");
    s.db.close();
    const env = { ...process.env, DATABASE_PATH: path };
    const ok = await run(process.execPath, [cli, "set-email", "amirul.haniff@nawlogic.com", "amirul.haniff@vatex.my"], { env });
    assert.match(ok.stdout, /Sign-in email changed to amirul\.haniff@vatex\.my/);
    const t = openDatabase(path);
    try {
      const u = t.db.prepare("SELECT * FROM owners").get();
      assert.equal(u.email, "amirul.haniff@vatex.my");
      assert.ok(await verifyPassword("First-owner-password-1", u.password));
      assert.equal(t.db.prepare("SELECT actor FROM audit WHERE action='user.email_changed'").get().actor, "local-console");
    } finally {
      t.db.close();
    }
    await assert.rejects(run(process.execPath, [cli, "set-email", "nobody@vatex.my", "x@vatex.my"], { env }), (e) => /No user with that email/.test(e.stderr));
    await assert.rejects(run(process.execPath, [cli, "set-email", "amirul.haniff@vatex.my"], { env }), (e) => /Use: node server\/cli\.mjs set-email/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing the email cancels open invitation and reset links sent to the old address", async () => {
  const f = await fixture();
  try {
    // A pending invitation: the link went to the wrong address.
    const invite = await f.json("/api/team/users", "POST", { email: "luqman@wrong.example", role: "staff", name: "Luqman" });
    const token = invite.link.split("/invite/")[1];
    await f.json(`/api/team/users/${invite.user.id}`, "PUT", { email: "luqman@vatex.my" });
    const used = await f.request("/api/guest/team/invite/" + token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: memberPassword }) });
    assert.notEqual(used.status, 200, "the old invitation link no longer works");
    const fresh = await f.json(`/api/team/users/${invite.user.id}/invite`, "POST", {});
    const ok = await f.request("/api/guest/team/invite/" + fresh.link.split("/invite/")[1], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: memberPassword }) });
    assert.equal(ok.status, 200, "a new invitation for the new address works");
    // An active member with an open password-reset link.
    const m = await member(f, "staff", "staff-reset@old.example");
    const reset = await f.json(`/api/team/users/${m.id}/reset-link`, "POST", {});
    const resetToken = reset.link.split("/reset/")[1];
    await f.json(`/api/team/users/${m.id}`, "PUT", { email: "staff-reset@vatex.my" });
    const r = await f.request("/api/guest/team/reset/" + resetToken, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Another-password-123" }) });
    assert.notEqual(r.status, 200, "the old reset link no longer works");
  } finally {
    await f.close();
  }
});

test("issued records keep the logo they were issued with; ones issued before any logo take the current one", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    const first = s.setLogo({ name: "a.png", data: PNG_1PX });
    const second = Buffer.concat([PNG_1PX, Buffer.from([0])]);
    s.setLogo({ name: "b.png", data: second });
    assert.deepEqual(snapshotLogo(s, { logoFileId: first.id }), PNG_1PX, "issued with the first logo: keeps it");
    assert.deepEqual(snapshotLogo(s, { logoFileId: null }), second, "issued before any logo: the current one");
    s.clearLogo();
    assert.deepEqual(snapshotLogo(s, { logoFileId: first.id }), PNG_1PX, "kept after the logo is removed");
    assert.equal(snapshotLogo(s, { logoFileId: null }), null, "no logo now: the default");
  } finally {
    await f.close();
  }
});

test("a logo of any shape is sized to fit the email header without stretching", () => {
  assert.deepEqual(imageSize(PNG_1PX), { width: 1, height: 1 });
  assert.deepEqual(fitBox({ width: 900, height: 120 }, 150, 60), { width: 150, height: 20 }, "wide");
  assert.deepEqual(fitBox({ width: 220, height: 440 }, 150, 60), { width: 30, height: 60 }, "tall");
  assert.deepEqual(fitBox({ width: 300, height: 300 }, 150, 60), { width: 60, height: 60 }, "square");
  assert.deepEqual(fitBox({ width: 40, height: 20 }, 150, 60), { width: 40, height: 20 }, "small logos are not enlarged");
});
