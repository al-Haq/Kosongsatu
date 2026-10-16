import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { requestContext } from "../server/context.mjs";
function fixture() {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-1",
    address: "Test office",
    email: "test@example.com",
  });
  const c = s.saveClient({ name: "Sales customer" }),
    other = s.saveClient({ name: "Other customer" });
  const q = () =>
    s.issue(
      s.saveDocument({
        kind: "quote",
        client_id: c.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: [{ description: "Integration", quantity: 1, rate: 100 }],
      }).id,
    );
  const accept = (q) =>
    s.acceptOffline(q.id, {
      name: "Verified customer",
      evidence: "Customer email reference TEST-1",
    });
  return { s, c, other, q, accept };
}
test("sales quotation proposals require owner review and apply exactly once", () => {
  const { s, c } = fixture();
  try {
    const o = s.saveOpportunity({
      client_id: c.id,
      title: "Systems project",
      expected_amount: 100,
    });
    const payload = {
      client_id: c.id,
      opportunity_id: o.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Scope", quantity: 1, rate: "100.00" }],
    };
    const p = s.propose("quotation", payload, "test", "proposal-test-000001");
    assert.equal(s.documents().length, 0);
    assert.equal(
      s.propose("quotation", payload, "test", "proposal-test-000001").id,
      p.id,
    );
    assert.throws(
      () =>
        s.propose(
          "quotation",
          { ...payload, notes: "changed" },
          "test",
          "proposal-test-000001",
        ),
      /different/,
    );
    const applied = s.reviewProposal(p.id, true);
    assert.equal(s.document(applied.id).state, "draft");
    assert.equal(s.sales().opportunities[0].quote_id, applied.id);
    assert.equal(s.reviewProposal(p.id, true).id, applied.id);
    assert.equal(s.documents().length, 1);
    assert.throws(
      () => s.propose("quotation", payload, "test", "proposal-test-000002"),
      /unquoted/,
    );
  } finally {
    s.db.close();
  }
});
test("expired, rejected and invalid proposals cannot mutate business records", () => {
  const { s, c } = fixture();
  try {
    assert.throws(
      () =>
        s.propose(
          "sales",
          { client_id: c.id, title: "Test", issue: true },
          "test",
          "proposal-test-000001",
        ),
      /Invalid tool/,
    );
    const p = s.propose(
      "sales",
      { client_id: c.id, title: "Test" },
      "test",
      "proposal-test-000002",
    );
    s.db
      .prepare("UPDATE automation_proposals SET expires=0 WHERE id=?")
      .run(p.id);
    assert.throws(() => s.reviewProposal(p.id, true), /expired/);
    assert.equal(s.sales().opportunities.length, 0);
    assert.throws(() => s.reviewProposal(p.id, false, ""), /Required/);
    s.reviewProposal(p.id, false, "Expired request");
    assert.throws(() => s.reviewProposal(p.id, true), /reviewed/);
  } finally {
    s.db.close();
  }
});
test("customer PO validates acceptance, currency amount, unique refs and links a single invoice", () => {
  const { s, c, q, accept } = fixture();
  try {
    const quote = q();
    const payload = {
      quote_id: quote.id,
      reference: "PO-CUSTOMER-1",
      amount: 100,
      po_date: today(),
    };
    assert.throws(() => s.registerPO(payload), /acceptance/);
    accept(quote);
    assert.throws(() => s.registerPO({ ...payload, amount: 99 }), /matching/);
    const po = s.registerPO(payload);
    assert.throws(() => s.registerPO(payload), /already/);
    const d = s.invoiceFromQuote(quote.id, po.id);
    assert.equal(d.state, "draft");
    assert.equal(d.total, 10000);
    assert.ok(d.notes.includes("PO-CUSTOMER-1"));
    assert.equal(s.invoiceFromQuote(quote.id, po.id).id, d.id);
    assert.equal(s.sales().purchaseOrders[0].invoice_id, d.id);
    const q2 = q();
    accept(q2);
    assert.throws(
      () =>
        s.registerPO({
          ...payload,
          quote_id: q2.id,
          reference: "po-customer-1",
        }),
      /already/,
    );
    assert.throws(() => s.invoiceFromQuote(q2.id, po.id), /does not belong/);
  } finally {
    s.db.close();
  }
});
test("offline acceptance requires evidence and audit distinguishes it from portal acceptance", () => {
  const { s, q } = fixture();
  try {
    const quote = q();
    assert.throws(
      () => s.acceptOffline(quote.id, { name: "Customer", evidence: "" }),
      /Required/,
    );
    assert.equal(s.document(quote.id).state, "issued");
    requestContext.run({ actor: "owner:test@example.com" }, () =>
      s.acceptOffline(quote.id, { name: "Customer", evidence: "Email E-1" }),
    );
    const a = s.db
      .prepare("SELECT * FROM audit WHERE action='quotation.accepted.offline'")
      .get();
    assert.equal(a.actor, "owner:test@example.com");
    assert.equal(a.detail, "Email E-1");
    assert.ok(
      s.db
        .prepare("SELECT id FROM automation_events WHERE type='quote.accepted'")
        .get(),
    );
  } finally {
    s.db.close();
  }
});
test("rules are opt-in, future-event only and replay-safe; PO automation never issues invoices", () => {
  const { s, q, accept } = fixture();
  try {
    const old = q();
    accept(old);
    s.setRule("accepted_quote_review", true);
    s.runAutomations();
    assert.equal(s.automationState().proposals.length, 0);
    const next = q();
    accept(next);
    s.setRule("accepted_quote_review", true); // Reapplying the same policy must not skip pending events.
    s.runAutomations();
    s.runAutomations();
    assert.equal(s.automationState().proposals.length, 1);
    assert.equal(s.automationState().runs.length, 1);
    s.setRule("customer_po_invoice", true);
    const po = s.registerPO({
      quote_id: next.id,
      reference: "AUTO-PO",
      amount: 100,
    });
    s.runAutomations();
    s.runAutomations();
    assert.equal(
      s.sales().purchaseOrders.find((p) => p.id === po.id).invoice_id,
      s.documents().find((d) => d.source_quote === next.id).id,
    );
    assert.equal(s.documents().filter((d) => d.kind === "invoice").length, 1);
    assert.equal(
      s.documents().find((d) => d.kind === "invoice").state,
      "draft",
    );
  } finally {
    s.db.close();
  }
});
test("failed workflow rolls back partial action and can retry with an audited record", () => {
  const { s, q, accept } = fixture();
  try {
    s.setRule("customer_po_invoice", true);
    const quote = q();
    accept(quote);
    s.registerPO({ quote_id: quote.id, reference: "FAIL-PO", amount: 100 });
    const convert = s.convert;
    s.convert = function (qid) {
      const d = convert.call(this, qid);
      throw new Error("Simulated failure after draft insert");
    };
    s.runAutomations();
    assert.equal(s.documents().filter((d) => d.kind === "invoice").length, 0);
    const failed = s.automationState().runs.find((r) => r.state === "failed");
    assert.ok(failed);
    s.convert = convert;
    s.retryAutomation(failed.id);
    assert.equal(s.documents().filter((d) => d.kind === "invoice").length, 1);
    assert.ok(
      s.db
        .prepare(
          "SELECT id FROM audit WHERE action='automation.retry.requested'",
        )
        .get(),
    );
  } finally {
    s.db.close();
  }
});
test("tool permissions, strict schemas and read projections prevent approval and secret disclosure", () => {
  const { s, c, q } = fixture();
  try {
    const quote = q();
    const privateLink = s.share(quote.id);
    const scoped = { scopes: ["business:read"], source: "connector:test" };
    assert.throws(
      () =>
        s.toolCall(
          "propose_sales",
          {
            request_key: "proposal-test-000001",
            data: { client_id: c.id, title: "Forbidden" },
          },
          scoped,
        ),
      /scope/,
    );
    assert.throws(() => s.toolCall("approve_proposal", {}, scoped), /Unknown/);
    assert.throws(
      () => s.toolCall("pipeline_summary", { extra: "ignored" }, scoped),
      /Invalid/,
    );
    const d = s.toolCall("get_document", { id: quote.id }, scoped);
    const str = JSON.stringify(d);
    for (const field of [
      "token_hash",
      "bankAccount",
      "business_snapshot",
      "payments",
    ])
      assert.ok(!str.includes(field));
    assert.ok(!str.includes(privateLink.token));
    assert.equal(
      s.toolCall("search_records", { kind: "clients" }, scoped)[0].email,
      undefined,
    );
    assert.throws(() => s.toolCall("read_events", {}, scoped), /scope/);
  } finally {
    s.db.close();
  }
});
test("connector tokens are hashed, scoped, expiring and revocable", () => {
  const { s } = fixture();
  try {
    const created = s.createConnector({
      label: "n8n",
      scopes: ["events:read"],
      days: 1,
    });
    assert.ok(!JSON.stringify(s.connectorTokens()).includes(created.token));
    assert.notEqual(
      s.db.prepare("SELECT hash FROM integration_tokens").get().hash,
      created.token,
    );
    assert.equal(s.connector(created.token).scopes[0], "events:read");
    s.revokeConnector(created.id);
    assert.throws(() => s.connector(created.token), /revoked/);
    const second = s.createConnector({
      label: "Read",
      scopes: ["business:read"],
      days: 1,
    });
    s.db
      .prepare("UPDATE integration_tokens SET expires=0 WHERE id=?")
      .run(second.id);
    assert.throws(() => s.connector(second.token), /expired/);
  } finally {
    s.db.close();
  }
});

test("PO workflow reuses an existing draft and adds its reference; it does not revive void invoices", () => {
  const { s, q, accept } = fixture();
  try {
    const quote = q();
    accept(quote);
    const d = s.convert(quote.id);
    const po = s.registerPO({
      quote_id: quote.id,
      reference: "EXISTING-DRAFT-PO",
      amount: 100,
    });
    assert.equal(po.invoice_id, null);
    const updated = s.invoiceFromQuote(quote.id, po.id);
    assert.equal(updated.id, d.id);
    assert.ok(updated.notes.includes("EXISTING-DRAFT-PO"));
    s.void(d.id, "Cancelled scope");
    assert.throws(() => s.invoiceFromQuote(quote.id, po.id), /void/);
    assert.equal(s.documents().filter((d) => d.kind === "invoice").length, 1);
  } finally {
    s.db.close();
  }
});
test("retry of a failed run is refused while its rule is disabled, and the failure stays visible", () => {
  const { s, q, accept } = fixture();
  try {
    s.setRule("customer_po_invoice", true);
    const quote = q();
    accept(quote);
    s.registerPO({ quote_id: quote.id, reference: "OFF-PO", amount: 100 });
    const convert = s.convert;
    s.convert = () => {
      throw new Error("Simulated failure");
    };
    s.runAutomations();
    s.convert = convert;
    const failed = s.automationState().runs.find((r) => r.state === "failed");
    s.setRule("customer_po_invoice", false);
    assert.throws(() => s.retryAutomation(failed.id), /Enable this rule/);
    assert.ok(
      s.automationState().runs.find((r) => r.id === failed.id),
      "failed run must not be deleted by a refused retry",
    );
  } finally {
    s.db.close();
  }
});
test("proposal fingerprints ignore key order and prototype names are not proposal kinds", () => {
  const { s, c } = fixture();
  try {
    const a = s.propose(
      "sales",
      { client_id: c.id, title: "Order test", expected_amount: "10.00" },
      "test",
      "proposal-order-000001",
    );
    const b = s.propose(
      "sales",
      { expected_amount: "10.00", title: "Order test", client_id: c.id },
      "test",
      "proposal-order-000001",
    );
    assert.equal(a.id, b.id);
    for (const kind of ["constructor", "__proto__", "toString"])
      assert.throws(
        () => s.propose(kind, {}, "test", "proposal-proto-000001"),
        /Unknown proposal type/,
      );
  } finally {
    s.db.close();
  }
});
