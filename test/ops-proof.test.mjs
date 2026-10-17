import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { renderPdf } from "../server/pdf.mjs";
import { fixture, issuedInvoice, PNG_1PX } from "./helpers.mjs";

const PDF_BYTES = Buffer.from("%PDF-1.4\n% not a photo\n");
const upload = (f, did, kind, visible, data = PNG_1PX) =>
  f.auth(`/api/ops/documents/${did}/photos?kind=${kind}&visible=${visible ? 1 : 0}&name=${kind}.png`, "POST", new Uint8Array(data), {
    "Content-Type": "application/octet-stream",
  });

test("work photos, log and report are private until marked visible", () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "R", address: "A", email: "a@example.com" });
    const { invoice } = issuedInvoice(s);
    const a = s.addWorkPhoto(invoice.id, { kind: "before", name: "rack", data: PNG_1PX });
    const b = s.addWorkPhoto(invoice.id, { kind: "after", name: "rack-done", data: PNG_1PX, visible: true });
    assert.equal(a.visibility, "private");
    assert.throws(() => s.addWorkPhoto(invoice.id, { kind: "during", data: PNG_1PX }), /before or after/);
    assert.throws(() => s.addWorkPhoto(invoice.id, { kind: "before", data: PDF_BYTES }), /allowed type/, "images only");
    s.saveWorkLog(invoice.id, { log_date: today(), person: "Ali", notes: "Replaced switch", visible: true });
    s.saveWorkLog(invoice.id, { log_date: today(), person: "Siti", notes: "Internal: client was late" });
    assert.throws(() => s.saveWorkLog(invoice.id, { log_date: addDays(today(), 1), person: "X", notes: "Y" }), /future/);
    s.saveWorkReport(invoice.id, { report: "All ports tested." });
    let pub = s.publicWork(invoice.id);
    assert.deepEqual(pub.photos.map((p) => p.id), [b.id]);
    assert.deepEqual(pub.logs.map((l) => l.person), ["Ali"]);
    assert.equal(pub.report, "", "report is private by default");
    s.saveWorkReport(invoice.id, { visible: true });
    s.setWorkPhotoVisibility(a.id, true);
    pub = s.publicWork(invoice.id);
    assert.equal(pub.report, "All ports tested.");
    assert.equal(pub.photos.length, 2);
    assert.throws(() => s.publicWorkPhoto("another-document", a.id), /Not found/);
    assert.equal(s.proofOfWork(invoice.id).logs.length, 2);
    s.void(invoice.id, "Wrong client");
    assert.throws(() => s.saveWorkLog(invoice.id, { person: "Z", notes: "late" }), /void/);
  } finally {
    s.db.close();
  }
});

test("PDF includes up to 4 client-visible PNG/JPEG photos and the visible log", async () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "R", address: "A", email: "a@example.com" });
    const { invoice } = issuedInvoice(s);
    for (let n = 0; n < 6; n++) s.addWorkPhoto(invoice.id, { kind: n < 3 ? "before" : "after", name: "p" + n, data: PNG_1PX, visible: true });
    s.addWorkPhoto(invoice.id, { kind: "after", name: "private", data: PNG_1PX });
    s.saveWorkLog(invoice.id, { person: "Ali", notes: "Visible note", visible: true });
    s.saveWorkLog(invoice.id, { person: "Ali", notes: "Hidden note" });
    const blocks = await s.pdfBlocks(s.document(invoice.id));
    assert.equal(blocks.filter((b) => b.image).length, 4);
    const log = blocks.find((b) => b.heading === "Work log");
    assert.ok(log.text.includes("Visible note") && !log.text.includes("Hidden note"));
    assert.ok(!blocks.some((b) => String(b.text).includes("private")));
    const pdf = await renderPdf(s.document(invoice.id), null, blocks);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    s.saveWorkReport(invoice.id, { pdf: false });
    assert.deepEqual(await s.pdfBlocks(s.document(invoice.id)), [], "the owner can leave proof of work out of the PDF");
  } finally {
    s.db.close();
  }
});

test("deleting a draft removes its proof of work", () => {
  const s = openDatabase(":memory:");
  try {
    const c = s.saveClient({ name: "Draft client" });
    const d = s.saveDocument({ kind: "quote", client_id: c.id, issue_date: today(), due_date: addDays(today(), 7), items: [{ description: "Job", quantity: 1, rate: "50" }] });
    s.addWorkPhoto(d.id, { kind: "before", data: PNG_1PX });
    s.saveWorkLog(d.id, { person: "Ali", notes: "Survey" });
    s.saveWorkReport(d.id, { report: "Survey done" });
    s.deleteDraft(d.id);
    assert.equal(s.db.prepare("SELECT count(*) n FROM files").get().n, 0);
    assert.equal(s.db.prepare("SELECT count(*) n FROM ops_work_logs").get().n, 0);
  } finally {
    s.db.close();
  }
});

test("client links only reach client-visible work photos of their own document", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const other = issuedInvoice(f.store).invoice;
    const visible = await (await upload(f, invoice.id, "after", true)).json();
    const hidden = await (await upload(f, invoice.id, "before", false)).json();
    const foreign = await (await upload(f, other.id, "after", true)).json();
    assert.equal((await upload(f, invoice.id, "after", true, PDF_BYTES)).status, 415);
    await f.json(`/api/ops/documents/${invoice.id}/logs`, "POST", { log_date: today(), person: "Ali", notes: "Done", visible: true });
    const link = await f.json(`/api/documents/${invoice.id}/share`, "POST", {});
    const token = link.url.split("/client/")[1];
    const pub = await (await f.request(`/api/public/${token}`)).json();
    assert.deepEqual(pub.ext.ops.work.photos.map((p) => p.id), [visible.id]);
    assert.equal(pub.ext.ops.work.logs[0].notes, "Done");
    assert.ok(!JSON.stringify(pub).includes(hidden.id));
    const ok = await f.request(`/api/guest/ops/work/${token}/${visible.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.match(ok.headers.get("content-security-policy"), /sandbox/);
    assert.equal((await f.request(`/api/guest/ops/work/${token}/${hidden.id}`)).status, 404, "private photo");
    assert.equal((await f.request(`/api/guest/ops/work/${token}/${foreign.id}`)).status, 404, "another document's photo");
    assert.equal((await f.request(`/api/guest/ops/work/${"x".repeat(43)}/${visible.id}`)).status, 404, "bad token");
    // Hiding a photo or revoking the link closes access.
    await f.json(`/api/ops/photos/${visible.id}`, "PUT", { visible: false });
    assert.equal((await f.request(`/api/guest/ops/work/${token}/${visible.id}`)).status, 404);
    await f.json(`/api/ops/photos/${visible.id}`, "PUT", { visible: true });
    await f.json(`/api/documents/${invoice.id}/revoke`, "POST", {});
    assert.equal((await f.request(`/api/guest/ops/work/${token}/${visible.id}`)).status, 404);
    const work = await f.json(`/api/ops/documents/${invoice.id}/work`);
    assert.equal(work.photos.length, 2);
    assert.equal((await f.request(`/api/ops/documents/${invoice.id}/work`)).status, 401);
  } finally {
    await f.close();
  }
});

test("the guest photo route is rate limited", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const photo = await (await upload(f, invoice.id, "after", true)).json();
    const token = (await f.json(`/api/documents/${invoice.id}/share`, "POST", {})).url.split("/client/")[1];
    let last;
    for (let n = 0; n < 121; n++) last = await f.request(`/api/guest/ops/work/${token}/${photo.id}`);
    assert.equal(last.status, 429);
  } finally {
    await f.close();
  }
});
