import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TEMPLATES,
  USES,
  LANGUAGES,
  renderTemplate,
  validateTemplate,
  documentVars,
  emailHtml,
  whatsappText,
  pickLanguage,
} from "../server/comms-templates.mjs";
const vars = {
  contact_name: "Ali",
  client_name: "Ali Sdn Bhd",
  number: "INV-2026-0001",
  amount: "RM 100.00",
  balance: "RM 100.00",
  due_date: "1 Nov 2026",
  company: "Nawlogic",
  bank_details: "Maybank\nNawlogic\n1234567890\nReference: INV-2026-0001",
  link: "https://app.example/client/abc",
};
test("every default template is valid in both languages", () => {
  for (const [use, langs] of Object.entries(DEFAULT_TEMPLATES))
    for (const lang of LANGUAGES) {
      const t = langs[lang];
      assert.ok(t, `${use}/${lang} exists`);
      assert.deepEqual(validateTemplate(t.subject, USES[use].vars), [], `${use}/${lang} subject`);
      assert.deepEqual(validateTemplate(t.body, USES[use].vars), [], `${use}/${lang} body`);
    }
});
test("sections appear only with a value and leave no stray blank lines", () => {
  const full = renderTemplate(DEFAULT_TEMPLATES.invoice.en.body, vars, USES.invoice.vars);
  assert.match(full, /Payment details:\nMaybank/);
  assert.match(full, /View and pay online: https:\/\/app\.example\/client\/abc/);
  const bare = renderTemplate(DEFAULT_TEMPLATES.invoice.en.body, { ...vars, link: "", bank_details: "" }, USES.invoice.vars);
  assert.doesNotMatch(bare, /Payment details|View and pay/);
  assert.doesNotMatch(bare, /\n{3,}/);
  assert.equal(renderTemplate("{{^link}}No link{{/link}}", {}, ["link"]), "No link");
  const ms = renderTemplate(DEFAULT_TEMPLATES.reminder_after.ms.body, vars, USES.reminder_after.vars);
  assert.match(ms, /^Salam sejahtera Ali,/);
  assert.match(ms, /Maklumat pembayaran:/);
});
test("unknown placeholders and broken braces are reported, never sent", () => {
  assert.match(validateTemplate("Hi {{nmber}}", USES.invoice.vars)[0], /Unknown placeholder \{\{nmber\}\}/);
  assert.match(validateTemplate("Hi {{number}", USES.invoice.vars)[0], /Check the braces/);
  assert.match(validateTemplate("{{#link}}x", USES.invoice.vars)[0], /Close \{\{#link\}\}/);
  assert.match(validateTemplate("{{/link}}", USES.invoice.vars)[0], /no matching/);
  assert.match(validateTemplate("{{days_overdue}}", USES.invoice.vars)[0], /Unknown placeholder/);
  assert.throws(() => renderTemplate("Dear {{client}}", vars, USES.invoice.vars), /Unknown placeholder/);
});
test("values are inserted once and are not parsed as placeholders", () => {
  const out = renderTemplate("A {{client_name}} B", { client_name: "{{company}} <b>" }, USES.invoice.vars);
  assert.equal(out, "A {{company}} <b> B");
  assert.equal(
    renderTemplate("Invoice {{number}}\nfrom {{company}}", vars, USES.invoice.vars, { singleLine: true }),
    "Invoice INV-2026-0001 from Nawlogic",
  );
});
test("kept placeholders survive a first render and fill in later", () => {
  const partial = renderTemplate(DEFAULT_TEMPLATES.invoice.en.body, vars, USES.invoice.vars, { keep: ["link"] });
  assert.match(partial, /\{\{#link\}\}\n\nView and pay online: \{\{link\}\}\n\{\{\/link\}\}/);
  const final = renderTemplate(partial, vars, USES.invoice.vars);
  assert.equal(final, renderTemplate(DEFAULT_TEMPLATES.invoice.en.body, vars, USES.invoice.vars));
});
test("the HTML part escapes every value and links only http(s) addresses", () => {
  const html = emailHtml({
    text: 'Hello <script>alert(1)</script> & "you"\n\nSee https://app.example/client/abc.',
    company: 'ACME <img src=x onerror=alert(1)>',
    button: { label: "Pay <now>", url: "javascript:alert(1)" },
    pixel: "https://app.example/api/guest/comms/open/x.gif",
  });
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/app\.example\/client\/abc" style="color:#087f7e">https:\/\/app\.example\/client\/abc<\/a>\./);
  assert.doesNotMatch(html, /javascript:/, "unsafe button links are dropped");
  assert.match(html, /open\/x\.gif" width="1" height="1"/);
});
test("document values follow the language, currency and instalment due date", () => {
  const d = {
    kind: "invoice",
    number: "INV-1",
    issue_date: "2026-10-01",
    due_date: "2026-10-15",
    next_due_date: "2026-11-15",
    total: 150000,
    balance: 50000,
    paid: 100000,
    currency: "USD",
    client: { name: "Client", contact: "" },
    business: { company: "Co", bankAccount: "999", bankName: "Bank" },
  };
  const en = documentVars(d, { lang: "en", asOf: "2026-11-20" });
  assert.equal(en.due_date, "15 Nov 2026");
  assert.equal(en.days_overdue, "5");
  assert.equal(en.contact_name, "Client", "contact falls back to the client name");
  assert.match(en.balance, /500\.00/);
  assert.match(en.balance, /US\$|USD/);
  assert.match(en.bank_details, /Reference: INV-1/);
  const ms = documentVars({ ...d, kind: "quote" }, { lang: "ms" });
  assert.equal(ms.document_type, "sebut harga");
  assert.equal(ms.bank_details, "", "quotations carry no bank details");
  assert.equal(pickLanguage(undefined, "zh", "ms"), "ms");
  assert.equal(pickLanguage(), "en");
});
test("WhatsApp parameters never contain new lines, tabs or long runs of spaces", () => {
  assert.equal(whatsappText("Bank\nAcc 123\n\tRef      X"), "Bank, Acc 123, Ref   X");
});
