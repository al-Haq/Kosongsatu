import { id, now, today, text, date, money, check } from "./domain.mjs";
export const RULES = [
  {
    id: "accepted_quote_review",
    name: "Accepted quotation → invoice proposal",
    description:
      "Queue an invoice draft proposal for owner review when a customer accepts a quote.",
  },
  {
    id: "customer_po_invoice",
    name: "Customer PO → invoice draft",
    description:
      "Automatically create one draft invoice from the accepted quotation when its matching customer PO is recorded. Never issue or send it.",
  },
];
export function attachSales(Store) {
  const accept = Store.prototype.accept,
    issue = Store.prototype.issue;
  Object.assign(Store.prototype, {
    emit(type, entity_id, payload = {}) {
      const out = this.db
        .prepare(
          "INSERT INTO automation_events(type,entity_id,payload,created) VALUES(?,?,?,?)",
        )
        .run(type, entity_id, JSON.stringify(payload), now());
      return Number(out.lastInsertRowid);
    },
    sales() {
      return {
        opportunities: this.db
          .prepare("SELECT * FROM sales_opportunities ORDER BY updated DESC,id")
          .all(),
        purchaseOrders: this.db
          .prepare("SELECT * FROM customer_pos ORDER BY created DESC,id")
          .all(),
      };
    },
    saveOpportunity(b, sid) {
      return this.tx(() => {
        const old = sid
          ? this.db
              .prepare("SELECT * FROM sales_opportunities WHERE id=?")
              .get(sid)
          : null;
        if (sid) check(old, "Sales opportunity not found.", 404);
        const client_id = b.client_id || old?.client_id;
        this.client(client_id);
        check(
          !old?.quote_id || client_id === old.client_id,
          "An opportunity linked to a quotation cannot change customer.",
        );
        const stage = text(b.stage || old?.stage || "new", 20, true);
        check(
          ["new", "qualified", "quoted", "won", "lost"].includes(stage),
          "Invalid sales stage.",
        );
        const out = {
          id: sid || id(),
          client_id,
          title: text(b.title ?? old?.title, 180, true),
          description: text(b.description ?? old?.description ?? "", 1000),
          stage,
          expected_amount:
            b.expected_amount === undefined
              ? old?.expected_amount || 0
              : money(b.expected_amount),
          created: old?.created || now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO sales_opportunities(id,client_id,title,description,stage,expected_amount,created,updated) VALUES(:id,:client_id,:title,:description,:stage,:expected_amount,:created,:updated) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,stage=excluded.stage,expected_amount=excluded.expected_amount,client_id=excluded.client_id,updated=excluded.updated",
          )
          .run(out);
        this.audit("sales.opportunity.saved", out.id, out.title, old, out);
        this.emit(old ? "sales.updated" : "sales.created", out.id, {
          client_id,
          stage,
        });
        return this.db
          .prepare("SELECT * FROM sales_opportunities WHERE id=?")
          .get(out.id);
      });
    },
    linkOpportunity(sid, qid) {
      const s = this.db
          .prepare("SELECT * FROM sales_opportunities WHERE id=?")
          .get(sid),
        q = this.document(qid);
      check(
        s && q.kind === "quote" && s.client_id === q.client_id,
        "Quotation and opportunity must have the same customer.",
      );
      check(
        !s.quote_id || s.quote_id === qid,
        "This opportunity already has a quotation.",
      );
      this.db
        .prepare(
          "UPDATE sales_opportunities SET quote_id=?,stage='quoted',updated=? WHERE id=?",
        )
        .run(qid, now(), sid);
      this.audit("sales.quotation.linked", sid, qid);
    },
    accept(token, name) {
      return this.tx(() => {
        const out = accept.call(this, token, name);
        this.emit("quote.accepted", out.id, { client_id: out.client_id });
        return out;
      });
    },
    issue(qid) {
      return this.tx(() => {
        const out = issue.call(this, qid);
        this.emit(
          out.kind === "quote" ? "quote.issued" : "invoice.issued",
          out.id,
          { client_id: out.client_id, number: out.number },
        );
        return out;
      });
    },
    acceptOffline(qid, b) {
      return this.tx(() => {
        const q = this.document(qid);
        check(
          q.kind === "quote" && q.state === "issued" && q.due_date >= today(),
          "Choose an issued, unexpired quotation.",
        );
        const name = text(b.name, 120, true),
          evidence = text(b.evidence, 1000, true);
        this.db
          .prepare(
            "UPDATE documents SET state='accepted',accepted_name=?,updated=? WHERE id=?",
          )
          .run(name, now(), qid);
        this.audit(
          "quotation.accepted.offline",
          qid,
          evidence,
          { state: q.state },
          { state: "accepted", accepted_name: name },
        );
        this.emit("quote.accepted", qid, { client_id: q.client_id });
        return this.document(qid);
      });
    },
    registerPO(b) {
      return this.tx(() => {
        const q = this.document(b.quote_id);
        check(
          q.kind === "quote" && q.state === "accepted",
          "Record customer acceptance before registering the PO.",
        );
        const reference = text(b.reference, 120, true),
          reference_key = reference.toUpperCase().replace(/\s+/g, " "),
          amount = money(b.amount),
          po_date = date(b.po_date || today());
        check(po_date <= today(), "PO cannot be future dated.");
        check(
          amount === q.total,
          "This release supports a full-value MYR PO matching the accepted quotation.",
        );
        check(
          !this.db
            .prepare(
              "SELECT id FROM customer_pos WHERE quote_id=? OR (client_id=? AND reference_key=?)",
            )
            .get(q.id, q.client_id, reference_key),
          "PO or quotation already registered.",
          409,
        );
        const existing = this.db
          .prepare("SELECT id,state FROM documents WHERE source_quote=?")
          .get(q.id);
        const out = {
          id: id(),
          client_id: q.client_id,
          quote_id: q.id,
          reference,
          reference_key,
          amount,
          po_date,
          notes: text(b.notes || "", 1000),
          invoice_id:
            existing && existing.state !== "draft" ? existing.id : null,
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO customer_pos VALUES(:id,:client_id,:quote_id,:reference,:reference_key,:amount,:po_date,:notes,:invoice_id,:created)",
          )
          .run(out);
        this.db
          .prepare(
            "UPDATE sales_opportunities SET stage='won',updated=? WHERE quote_id=?",
          )
          .run(now(), q.id);
        this.audit("customer_po.received", out.id, reference, null, out);
        this.emit("customer_po.received", out.id, {
          quote_id: q.id,
          client_id: q.client_id,
        });
        return out;
      });
    },
    invoiceFromQuote(qid, poid) {
      return this.tx(() => {
        const q = this.document(qid);
        check(
          q.kind === "quote" && q.state === "accepted",
          "Quotation must be accepted.",
        );
        let po = poid
          ? this.db.prepare("SELECT * FROM customer_pos WHERE id=?").get(poid)
          : this.db
              .prepare("SELECT * FROM customer_pos WHERE quote_id=?")
              .get(qid);
        if (poid)
          check(
            po && po.quote_id === qid,
            "PO does not belong to this quotation.",
          );
        if (po)
          check(po.amount === q.total, "PO total does not match quotation.");
        const existing = this.db
          .prepare("SELECT state FROM documents WHERE source_quote=?")
          .get(qid);
        check(
          existing?.state !== "void",
          "The linked invoice is void. Resolve the quotation/order correction before conversion.",
        );
        const d = this.convert(qid);
        if (po) {
          if (!po.invoice_id) {
            check(
              d.state === "draft",
              "Existing invoice is already issued; link the PO through a reviewed correction workflow.",
            );
            this.db
              .prepare("UPDATE customer_pos SET invoice_id=? WHERE id=?")
              .run(d.id, po.id);
            const notes = [d.notes, `Customer PO: ${po.reference}`]
              .filter(Boolean)
              .join("\n");
            check(
              notes.length <= 1000,
              "Make room for the PO reference in the invoice draft notes, then retry.",
            );
            this.db
              .prepare("UPDATE documents SET notes=?,updated=? WHERE id=?")
              .run(notes, now(), d.id);
          } else
            check(
              po.invoice_id === d.id,
              "PO is already linked to another invoice.",
            );
        }
        return this.document(d.id);
      });
    },
    automationState() {
      return {
        rules: RULES.map((r) => ({
          ...r,
          enabled: !!this.db
            .prepare("SELECT enabled FROM automation_rules WHERE id=?")
            .get(r.id).enabled,
        })),
        proposals: this.db
          .prepare(
            "SELECT * FROM automation_proposals ORDER BY created DESC,id LIMIT 100",
          )
          .all()
          .map((p) => ({
            ...p,
            payload: JSON.parse(p.payload),
            result: p.result ? JSON.parse(p.result) : null,
          })),
        runs: this.db
          .prepare(
            "SELECT * FROM automation_runs ORDER BY created DESC,id LIMIT 100",
          )
          .all(),
        pendingEvents: this.db
          .prepare("SELECT count(*) n FROM automation_events WHERE processed=0")
          .get().n,
      };
    },
    setRule(rid, enabled) {
      check(
        RULES.some((r) => r.id === rid),
        "Unknown automation rule.",
      );
      check(typeof enabled === "boolean", "Use a boolean for enabled.");
      if (
        !!this.db
          .prepare("SELECT enabled FROM automation_rules WHERE id=?")
          .get(rid).enabled === enabled
      )
        return;
      this.db
        .prepare(
          "UPDATE automation_rules SET enabled=?,enabled_after=? WHERE id=?",
        )
        .run(
          enabled ? 1 : 0,
          this.db
            .prepare("SELECT COALESCE(max(id),0) n FROM automation_events")
            .get().n,
          rid,
        );
      this.audit(
        "automation.rule.changed",
        rid,
        "Owner configured deterministic automation",
        null,
        { enabled },
      );
    },
    runAutomations() {
      const events = this.db
        .prepare(
          "SELECT * FROM automation_events WHERE processed=0 ORDER BY id LIMIT 25",
        )
        .all();
      let count = 0;
      for (const e of events)
        this.tx(() => {
          if (
            this.db
              .prepare("SELECT processed FROM automation_events WHERE id=?")
              .get(e.id).processed
          )
            return;
          for (const rule of this.db
            .prepare(
              "SELECT id,enabled_after FROM automation_rules WHERE enabled=1",
            )
            .all()) {
            if (e.id <= rule.enabled_after) continue;
            if (
              !(
                (rule.id === "accepted_quote_review" &&
                  e.type === "quote.accepted") ||
                (rule.id === "customer_po_invoice" &&
                  e.type === "customer_po.received")
              )
            )
              continue;
            if (
              this.db
                .prepare(
                  "SELECT id FROM automation_runs WHERE event_id=? AND rule_id=?",
                )
                .get(e.id, rule.id)
            )
              continue;
            // A savepoint keeps a failed rule from committing any partial draft or proposal.
            this.db.exec("SAVEPOINT automation_action");
            let state = "completed",
              result = null,
              error = null;
            try {
              if (rule.id === "accepted_quote_review") {
                result = this.propose(
                  "invoice_from_quote",
                  { quote_id: e.entity_id },
                  "rule:" + rule.id,
                  "event-" + String(e.id).padStart(20, "0"),
                );
              } else {
                const po = this.db
                  .prepare("SELECT * FROM customer_pos WHERE id=?")
                  .get(e.entity_id);
                check(po, "PO not found.");
                result = { id: this.invoiceFromQuote(po.quote_id, po.id).id };
              }
              this.db.exec("RELEASE automation_action");
            } catch (err) {
              this.db.exec(
                "ROLLBACK TO automation_action;RELEASE automation_action",
              );
              state = "failed";
              error = err.status
                ? err.message
                : "Automation failed; inspect server records.";
            }
            this.db
              .prepare("INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?)")
              .run(
                id(),
                e.id,
                rule.id,
                state,
                result ? JSON.stringify(result) : null,
                error,
                now(),
              );
            this.audit(
              "automation.rule." + state,
              rule.id,
              error || JSON.stringify(result),
            );
            count++;
          }
          this.db
            .prepare("UPDATE automation_events SET processed=1 WHERE id=?")
            .run(e.id);
        });
      return { processed: events.length, runs: count };
    },
    retryAutomation(runId) {
      const run = this.db
        .prepare("SELECT * FROM automation_runs WHERE id=? AND state='failed'")
        .get(runId);
      check(run, "Failed run not found.", 404);
      this.db.prepare("DELETE FROM automation_runs WHERE id=?").run(runId);
      this.db
        .prepare("UPDATE automation_events SET processed=0 WHERE id=?")
        .run(run.event_id);
      this.audit(
        "automation.retry.requested",
        runId,
        "Prior failure retained in audit",
      );
      return this.runAutomations();
    },
  });
}
