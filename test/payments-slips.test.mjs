import test from "node:test";
import assert from "node:assert/strict";
import { fixture, issuedInvoice, PNG_1PX } from "./helpers.mjs";

async function setup() {
  const f = await fixture();
  const { invoice } = issuedInvoice(f.store, { rate: "300.00" });
  const { token } = f.store.share(invoice.id);
  const upload = (body, q = {}, headers = {}, t = token) =>
    f.request(`/api/guest/payments/slip/${t}?` + new URLSearchParams({ reference: "MBB12345", name: "slip.png", ...q }), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body,
    });
  return { ...f, invoice, token, upload };
}

test("clients attach a private payment slip to their transaction reference", async () => {
  const f = await setup();
  try {
    const res = await f.upload(PNG_1PX, { note: "Paid by DuitNow" });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(await res.json()).sort(), ["created", "reference", "slip", "status"]);
    const d = f.store.document(f.invoice.id);
    assert.equal(d.proofs.length, 1);
    assert.equal(d.proofs[0].status, "pending");
    assert.equal(d.proofs[0].note, "Paid by DuitNow");
    const [file] = d.proofs[0].files;
    assert.equal(file.mime, "image/png");
    assert.equal(f.store.file(file.id).visibility, "private");
    // The client page only learns that a slip exists.
    const page = await (await f.request("/api/public/" + f.token)).json();
    assert.equal(page.proofs[0].slip, true);
    assert.ok(!JSON.stringify(page).includes(file.id), "no file ids on the client page");
    assert.equal((await f.request("/api/files/" + file.id)).status, 401, "owner only");
    const own = await f.auth(`/api/files/${file.id}`);
    assert.equal(own.status, 200);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG_1PX);
    // The owner's review panel data carries the slip.
    const ws = await f.json("/api/workspace");
    assert.equal(ws.documents.find((x) => x.id === f.invoice.id).proofs[0].files[0].id, file.id);
    // Confirming the reference keeps the slip with it.
    f.store.recordPayment(f.invoice.id, { amount: "300.00", paid_date: ws.today, method: "Bank transfer", reference: "MBB12345", proof_id: d.proofs[0].id });
    assert.equal(f.store.document(f.invoice.id).proofs[0].status, "confirmed");
    assert.equal(f.store.document(f.invoice.id).proofs[0].files.length, 1);
    assert.equal((await f.upload(PNG_1PX, { reference: "AGAIN" })).status, 409, "paid invoices take no more slips");
  } finally {
    await f.close();
  }
});

test("slip uploads check the link, the browser origin, the file type and size, and are rate limited", async () => {
  const f = await setup();
  try {
    assert.equal((await f.upload(PNG_1PX, {}, {}, "x".repeat(43))).status, 404);
    const crossSite = await fetch(`${f.base}/api/guest/payments/slip/${f.token}?reference=R1`, { method: "POST", headers: { Origin: "https://evil.example" }, body: PNG_1PX });
    assert.equal(crossSite.status, 403);
    const html = await f.upload(Buffer.from("<html><script>alert(1)</script></html>"), { reference: "R2" });
    assert.equal(html.status, 415);
    assert.equal(f.store.document(f.invoice.id).proofs.length, 0, "a refused file creates no reference");
    assert.equal((await f.upload(PNG_1PX, { reference: "" })).status, 400, "a reference is required");
    const big = await f.upload(Buffer.alloc(5 * 1024 * 1024 + 10, 1), { reference: "R3" });
    assert.equal(big.status, 413);
    const pdf = await f.upload(Buffer.from("%PDF-1.7\n1 0 obj\n"), { reference: "R4", name: "slip.pdf" });
    assert.equal(pdf.status, 201);
    assert.equal(f.store.document(f.invoice.id).proofs[0].files[0].mime, "application/pdf");
    let limited = false;
    for (let i = 0; i < 6; i++) if ((await f.upload(PNG_1PX, { reference: "RL" + i })).status === 429) limited = true;
    assert.ok(limited, "uploads are rate limited per address");
  } finally {
    await f.close();
  }
});
