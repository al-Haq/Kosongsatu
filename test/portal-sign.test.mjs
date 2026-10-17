import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { fixture, PNG_1PX } from "./helpers.mjs";
import { makePng, signatureData, issued, signatureInk } from "./portal-helpers.mjs";
import { inspectSignaturePng, decodeSignature } from "../server/portal-png.mjs";
import { renderPdf } from "../server/pdf.mjs";
import { today, addDays } from "../server/domain.mjs";

test("signature images are decoded, checked and re-encoded without metadata", () => {
  const good = makePng(600, 200, { extra: [["tEXt", "Comment\0<script>alert(1)</script>"]] });
  const out = inspectSignaturePng(good);
  assert.equal(out.width, 600);
  assert.ok(out.ink > 40);
  assert.ok(!out.png.includes(Buffer.from("script")), "text chunks are dropped");
  assert.deepEqual(inspectSignaturePng(out.png).ink, out.ink, "re-encoded image is equivalent");
  for (const color of [0, 2, 4]) assert.ok(inspectSignaturePng(makePng(300, 100, { color })).ink > 40);
  // Every PNG filter type decodes to the same pixels.
  for (const filter of [1, 2, 3, 4]) assert.equal(inspectSignaturePng(makePng(600, 200, { filter })).ink, out.ink, "filter " + filter);
  assert.throws(() => inspectSignaturePng(makePng(600, 200, { filter: 7 })), /damaged/);

  const bad = [
    [Buffer.from("not a png at all, not even close to it......................"), /PNG image/],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(80)]), /PNG image/],
    [PNG_1PX, /between 120×40/],
    [makePng(50, 20), /between/],
    [makePng(2000, 200), /between/],
    [makePng(600, 200, { ink: () => false }), /empty/],
    [makePng(600, 200, { ink: () => true }), /does not look like a signature/],
    [makePng(600, 200, { interlace: 1 }), /unsupported PNG format/],
    [makePng(600, 200, { color: 3 }), /unsupported PNG format/],
    [makePng(600, 200, { depth: 16 }), /unsupported PNG format/],
    [makePng(600, 200, { extra: [["PLTE", "abc"]] }), /unsupported format/],
    [makePng(600, 200, { idat: Buffer.from("garbage") }), /damaged/],
    // A small file that inflates far beyond the declared size is refused.
    [makePng(600, 200, { idat: deflateSync(Buffer.alloc(20 * 1024 * 1024)) }), /damaged/],
    [Buffer.concat([makePng(), Buffer.from("trailing")]), /incomplete|after its end/],
    [makePng().subarray(0, 200), /incomplete/],
  ];
  for (const [buf, msg] of bad) assert.throws(() => inspectSignaturePng(buf), msg);
  const flipped = Buffer.from(makePng());
  flipped[40] ^= 0xff;
  assert.throws(() => inspectSignaturePng(flipped), /damaged/, "chunk CRC checked");
  assert.throws(() => inspectSignaturePng(Buffer.alloc(90 * 1024, 1)), /too large/);
  assert.throws(() => decodeSignature("data:image/png;base64,<svg>"), /PNG/);
  assert.throws(() => decodeSignature(""), /signature/);
  assert.equal(decodeSignature(signatureData()).subarray(1, 4).toString(), "PNG");
});

async function quoteLink(f, options = {}) {
  const client = f.store.saveClient({ name: "Signer client", email: "signer@client.example" });
  const quote = issued(f.store, client, { kind: "quote", ...options });
  const { token } = f.store.share(quote.id);
  const post = (body, headers = {}) =>
    f.request(`/api/guest/portal/link/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "TestBrowser/1.0 (Phone)", ...headers },
      body: JSON.stringify(body),
    });
  return { client, quote, token, post };
}
const body = (extra = {}) => ({ name: "Aina Binti Ali", agree: true, method: "draw", signature: signatureData(), ...extra });

test("clients sign a quotation from its link: image, name, time, IP hash and browser are kept", async () => {
  const f = await fixture();
  try {
    const { quote, token, post } = await quoteLink(f);
    const res = await post(body());
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.state, "accepted");
    assert.equal(out.accepted_name, "Aina Binti Ali");
    const s = f.store.signature(quote.id);
    assert.equal(s.signer_name, "Aina Binti Ali");
    assert.equal(s.method, "draw");
    assert.equal(s.source, "link");
    assert.equal(s.user_agent, "TestBrowser/1.0 (Phone)");
    assert.match(s.ip_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(s.ip_hash, f.store.ipFingerprint("127.0.0.2"));
    assert.equal(s.ip_hash, f.store.ipFingerprint("127.0.0.1"), "keyed hash of the client address");
    assert.ok(!JSON.stringify(s).includes("127.0.0.1"), "the address itself is not stored");
    assert.match(s.document_hash, /^[0-9a-f]{64}$/);
    const file = f.store.files("document", quote.id, "signature")[0];
    assert.equal(file.mime, "image/png");
    assert.equal(file.visibility, "client");
    assert.equal(file.id, s.file_id);
    const audit = f.store.db.prepare("SELECT * FROM audit WHERE action='quotation.signed'").get();
    assert.equal(audit.actor, "client-link");
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='quotation.accepted' AND entity_id=?").get(quote.id));
    assert.ok(f.store.db.prepare("SELECT 1 FROM automation_events WHERE type='quote.accepted'").get());

    // The client page shows the signature without owner-only details.
    const page = await (await f.request("/api/public/" + token)).json();
    assert.equal(page.ext.portal.signature.signer_name, "Aina Binti Ali");
    assert.equal(page.ext.portal.signature.ip_hash, undefined);
    assert.equal(page.ext.portal.signature.user_agent, undefined);
    const img = await f.request(`/api/guest/portal/link/${token}/signature`);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.match(img.headers.get("content-security-policy"), /sandbox/);
    assert.equal((await f.request(`/api/guest/portal/link/${"z".repeat(43)}/signature`)).status, 404);

    assert.equal((await post(body())).status, 409, "a quotation is signed once");
    // The owner sees it and it cannot be removed.
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.portal.signatures[quote.id].file_id, s.file_id);
    assert.equal((await f.auth("/api/files/" + s.file_id, "DELETE")).status, 409);
    assert.throws(() => f.store.db.prepare("UPDATE portal_signatures SET signer_name='x'").run(), /permanent/);
    assert.throws(() => f.store.db.prepare("DELETE FROM portal_signatures").run(), /permanent/);
  } finally {
    await f.close();
  }
});

test("signing checks agreement, the image and the token in one transaction", async () => {
  const f = await fixture();
  try {
    const { quote, post } = await quoteLink(f);
    const cases = [
      [body({ agree: false }), 400, /agree/],
      [body({ agree: "on" }), 400, /agree/],
      [body({ name: "" }), 400, /Required/],
      [body({ method: "stamp" }), 400, /Draw or type/],
      [body({ signature: signatureData(makePng(600, 200, { ink: () => false })) }), 400, /empty/],
      [body({ signature: signatureData(makePng(60, 20)) }), 400, /between/],
      [body({ signature: "data:image/png;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64") }), 415, /PNG/],
      [body({ method: "type", typed: "Someone Else" }), 400, /exactly/],
    ];
    for (const [b, status, message] of cases) {
      const res = await post(b);
      assert.equal(res.status, status, JSON.stringify(b).slice(0, 60));
      assert.match((await res.json()).error, message);
    }
    assert.equal(f.store.document(quote.id).state, "issued", "nothing accepted on failure");
    assert.equal(f.store.files("document", quote.id).length, 0, "no file kept on failure");
    assert.equal(f.store.signature(quote.id), null);
    const typed = await post(body({ method: "type", typed: "aina binti ali" }));
    assert.equal(typed.status, 200);
    assert.equal(f.store.signature(quote.id).method, "type");

    const expired = await quoteLink(f, { issue: addDays(today(), -20), due: addDays(today(), -1) });
    assert.equal((await expired.post(body())).status, 409);
    assert.equal(f.store.files("document", expired.quote.id).length, 0);
    const bad = await f.request(`/api/guest/portal/link/${"q".repeat(43)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(bad.status, 404);
    const invoice = issued(f.store, f.store.saveClient({ name: "Invoice only" }));
    const { token } = f.store.share(invoice.id);
    const notQuote = await f.request(`/api/guest/portal/link/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    assert.equal(notQuote.status, 409);
    const cross = await f.request(`/api/guest/portal/link/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify(body()),
    });
    assert.equal(cross.status, 403);
  } finally {
    await f.close();
  }
});

test("signing is rate limited per address", async () => {
  const f = await fixture();
  try {
    const { post } = await quoteLink(f);
    let last;
    for (let i = 0; i < 13; i++) last = await post(body({ agree: false }));
    assert.equal(last.status, 429);
  } finally {
    await f.close();
  }
});

test("the quotation PDF prints the signature with the acceptance details", async () => {
  const f = await fixture();
  try {
    const { quote, token, post } = await quoteLink(f);
    const plain = await renderPdf(f.store.document(quote.id), null, await f.store.pdfBlocks(f.store.document(quote.id)));
    await post(body());
    const d = f.store.document(quote.id);
    const blocks = await f.store.pdfBlocks(d);
    const block = blocks.find((b) => b.heading === "Acceptance");
    assert.ok(block.image.subarray(1, 4).equals(Buffer.from("PNG")));
    assert.match(block.text, /^Accepted by Aina Binti Ali on .+\(Malaysia time\)/);
    assert.match(block.text, /Drawn electronic signature through the client link/);
    assert.ok(!block.text.includes(f.store.signature(quote.id).ip_hash), "no network details on the PDF");
    const signed = await renderPdf(d, null, blocks);
    assert.ok(signed.length > plain.length + 500);
    const pub = await f.request(`/api/public/${token}/pdf`);
    assert.ok(Buffer.from(await pub.arrayBuffer()).length > plain.length + 500, "client PDF includes it too");
    const invoice = issued(f.store, f.store.saveClient({ name: "Other" }));
    assert.deepEqual(await f.store.pdfBlocks(invoice), [], "invoices are unchanged");
  } finally {
    await f.close();
  }
});

test("the stroke helper draws a realistic signature", () => {
  let n = 0;
  for (let x = 0; x < 600; x++) for (let y = 0; y < 200; y++) if (signatureInk(x, y)) n++;
  assert.ok(n > 1000 && n < 600 * 200 * 0.1);
});
