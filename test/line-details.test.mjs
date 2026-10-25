// Each line has a title and, under it, an optional formatted description
// (bold, italic, strikethrough, bullet and numbered lists), shown on the
// document page, the client page and the PDF, and copied with the line.
import test from "node:test";
import assert from "node:assert/strict";
import { runs, blocks, detailsHtml, detailsPlain, htmlToDetails, DETAILS_MAX } from "../public/ext/line-details.mjs";
import { today, addDays } from "../server/domain.mjs";
import { eventsFromAudit } from "../server/platform-webhooks.mjs";
import { fixture } from "./helpers.mjs";

const DETAILS = "Website **up to 7 pages**.\n\n- Content & *copywriting*\n- ~~New logo~~ not included\n\n1. Design in 7 days\n2. Live in 21 days";

test("the description markup reads as bold, italic, strikethrough, bullets and numbers", () => {
  assert.deepEqual(runs("a **b** *c* ~~d~~"), [
    { text: "a ", b: false, i: false, s: false },
    { text: "b", b: true, i: false, s: false },
    { text: " ", b: false, i: false, s: false },
    { text: "c", b: false, i: true, s: false },
    { text: " ", b: false, i: false, s: false },
    { text: "d", b: false, i: false, s: true },
  ]);
  assert.deepEqual(runs("2 \\* 3 = 6"), [{ text: "2 * 3 = 6", b: false, i: false, s: false }], "a backslash keeps a star literal");
  assert.deepEqual(
    blocks(DETAILS).map((b) => [b.type, (b.lines || b.items).length]),
    [
      ["p", 1],
      ["ul", 2],
      ["ol", 2],
    ],
  );
  assert.equal(
    detailsHtml(DETAILS),
    "<p>Website <strong>up to 7 pages</strong>.</p><ul><li>Content &amp; <em>copywriting</em></li><li><s>New logo</s> not included</li></ul><ol><li>Design in 7 days</li><li>Live in 21 days</li></ol>",
  );
  assert.equal(detailsPlain(DETAILS), "Website up to 7 pages.\n\n- Content & copywriting\n- New logo not included\n\n1. Design in 7 days\n2. Live in 21 days");
});

test("description text is never HTML", () => {
  const html = detailsHtml('<img src=x onerror="alert(1)"> **<b>x</b>**\n- <script>alert(1)</script>');
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
});

test("a line's description is saved, limited, and copied when a quotation becomes an invoice or a document is duplicated", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    const c = s.saveClient({ name: "Client", email: "c@example.com" });
    const q = s.saveDocument({
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [
        { description: "Corporate website", details: DETAILS.replace(/\n/g, "\r\n"), quantity: 1, rate: "2650.00" },
        { description: "Hosting", details: "   ", quantity: 1, rate: "300.00" },
      ],
    });
    assert.equal(q.items[0].description, "Corporate website", "the title");
    assert.equal(q.items[0].details, DETAILS, "the description, with line breaks kept");
    assert.equal(q.items[1].details, undefined, "a blank description is not kept");
    assert.equal(q.total, 295000, "a description does not change the amounts");
    // Up to the limit, and a clear message past it.
    const draft = (details) => ({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Long", details, quantity: 1, rate: "1.00" }],
    });
    assert.equal(s.saveDocument(draft("x".repeat(DETAILS_MAX))).items[0].details.length, DETAILS_MAX);
    assert.throws(() => s.saveDocument(draft("x".repeat(DETAILS_MAX + 1))), /Line 1: the description can have up to 3000 characters/);
    // Quotation to invoice, and duplicate.
    s.issue(q.id);
    s.acceptOffline(q.id, { name: "Verified customer", evidence: "Customer email reference TEST-1" });
    const inv = s.convert(q.id);
    assert.equal(inv.items[0].details, DETAILS);
    // Webhooks carry it; a line without one has no details key.
    const [event] = eventsFromAudit(s, { action: "document.issued", entity_id: q.id, actor: "owner:x" }, "http://x");
    assert.equal(event.data.items[0].details, DETAILS);
    assert.equal("details" in event.data.items[1], false);
    assert.equal(s.duplicateDocument(inv.id).items[0].details, DETAILS);
    // Over HTTP: saved through the API, and the PDF draws it.
    const saved = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Corporate website", details: DETAILS, quantity: "1", rate: "2650.00" }],
    });
    assert.equal(saved.items[0].details, DETAILS);
    const pdf = await f.auth(`/api/documents/${saved.id}/pdf`);
    assert.equal(pdf.status, 200);
    const plainDoc = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Corporate website", quantity: "1", rate: "2650.00" }],
    });
    const plain = await f.auth(`/api/documents/${plainDoc.id}/pdf`);
    // A description taller than a page carries on to the next one.
    const list = Array.from({ length: 140 }, (_, n) => `- Scope item ${n + 1}`).join("\n");
    const tallDoc = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Big project", details: list.slice(0, DETAILS_MAX), quantity: "1", rate: "1.00" }],
    });
    const tallPdf = Buffer.from(await (await f.auth(`/api/documents/${tallDoc.id}/pdf`)).arrayBuffer()).toString("latin1");
    assert.ok((tallPdf.match(/\/Type \/Page\b/g) || []).length >= 3, "renders across three pages");
    // So does one paragraph longer than a page, in a narrow column (code, unit and discount shown).
    const para = "Development and **support**, with *training* and documentation. ".repeat(60).slice(0, DETAILS_MAX);
    const narrow = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [
        { description: "Setup", quantity: "1", rate: "100.00", sku: "SET-1", unit: "job", discount_amount: "10.00" },
        { description: "Big project", details: para, quantity: "1", rate: "1.00" },
      ],
    });
    const narrowPdf = await f.auth(`/api/documents/${narrow.id}/pdf`);
    assert.equal(narrowPdf.status, 200);
    const pages = (
      Buffer.from(await narrowPdf.arrayBuffer())
        .toString("latin1")
        .match(/\/Type \/Page\b/g) || []
    ).length;
    assert.ok(pages >= 2, "a long paragraph carries on to the next page");
    assert.ok((await pdf.arrayBuffer()).byteLength > (await plain.arrayBuffer()).byteLength, "the PDF with a description has more in it");
  } finally {
    await f.close();
  }
});

test("Chinese text in a description picks the Chinese font", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "Client" });
    const d = f.store.saveDocument({
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Website", details: "- 网站设计", quantity: 1, rate: "1.00" }],
    });
    assert.equal(f.store.needsCjk(d), true);
  } finally {
    await f.close();
  }
});

// A tiny stand-in for the editor's DOM: enough for htmlToDetails.
const txt = (value) => ({ nodeType: 3, nodeValue: value });
const el = (tag, ...kids) => ({ nodeType: 1, tagName: tag, childNodes: kids, children: kids.filter((k) => k.nodeType === 1), getAttribute: () => null });

test("formatting typed in the editor reads back exactly, also bold inside italic and side by side", () => {
  const cases = [
    [[el("EM", txt("first "), el("STRONG", txt("bold")), txt(" last"))], "<p><em>first </em><strong><em>bold</em></strong><em> last</em></p>"],
    [[el("EM", txt("italic "), el("STRONG", txt("both")))], "<p><em>italic </em><strong><em>both</em></strong></p>"],
    [[el("I", txt("x")), el("B", el("I", txt("y")))], "<p><em>x</em><strong><em>y</em></strong></p>"],
    [[el("EM", txt("a "), el("S", txt("gone")), txt(" b"))], "<p><em>a </em><em><s>gone</s></em><em> b</em></p>"],
    [[el("B", txt("one")), el("B", txt("two"))], "<p><strong>onetwo</strong></p>"],
    [[el("B", txt("2 * 3 ~ 4")), txt(" \\ end")], "<p><strong>2 * 3 ~ 4</strong> \\ end</p>"],
    [[el("DIV", el("B", txt("line one"))), el("DIV", txt("line "), el("I", txt("two")))], "<p><strong>line one</strong><br>line <em>two</em></p>"],
    [
      [el("UL", el("LI", el("EM", txt("it "), el("B", txt("bo")))), el("LI", txt("plain")))],
      "<ul><li><em>it </em><strong><em>bo</em></strong></li><li>plain</li></ul>",
    ],
    // Text that only looks like a list stays text, with its own number.
    [[el("DIV", txt("10. Maintenance within 30 days")), el("DIV", txt("- not a bullet"))], "<p>10. Maintenance within 30 days<br>- not a bullet</p>"],
    [[txt("2) second"), el("BR"), txt("• dot")], "<p>2) second<br>• dot</p>"],
    [[el("OL", el("LI", txt("1. inside a list")))], "<ol><li>1. inside a list</li></ol>"],
  ];
  for (const [kids, html] of cases) {
    const md = htmlToDetails(el("DIV", ...kids));
    assert.equal(detailsHtml(md), html, md);
  }
});
