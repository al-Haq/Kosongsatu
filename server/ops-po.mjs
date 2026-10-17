// Partial and amended customer POs (roadmap no. 67).
// A quotation may carry several customer POs; together they never exceed the
// quotation total. Each PO is invoiced once, for its own amount.
import {
  id,
  now,
  today,
  text,
  date,
  money,
  check,
  addDays,
  currency,
  allocateDiscount,
  calculate,
} from "./domain.mjs";
import { requestContext } from "./context.mjs";
export const PO_FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const MAX_PO_FILES = 10;
const keyOf = (reference) => reference.toUpperCase().replace(/\s+/g, " ");
const actor = () => requestContext.getStore()?.actor || "system";
// Amounts in messages follow the quotation's currency when one is set.
const fmt = (doc, sen) =>
  doc?.currency && doc.currency !== "MYR"
    ? `${doc.currency} ${(sen / 100).toFixed(2)}`
    : currency(sen);
// Line total including SST, exactly as calculate() works it out.
const gross = (net, rate) => net + Math.round((net * rate) / 100);
// The largest net amount whose total with SST does not pass `target`.
function netFor(target, rate) {
  if (!rate) return target;
  let t = Math.max(0, Math.floor((target * 100) / (100 + rate)) - 2);
  while (gross(t + 1, rate) <= target) t++;
  return t;
}
// Scales quotation lines to a partial PO amount (SST included) with exact sen.
// Every line keeps its SST rate and SST is worked out again on the scaled line,
// so the tax stays correct. When SST rounding makes the exact amount
// unreachable, the result is the closest total below the PO, never above.
export function scaleLines(items, discount, target) {
  const legacy = allocateDiscount(
    items.map((i) => i.amount),
    discount || 0,
  );
  const lines = items.map((i, n) => {
    const rate = Number(i.tax_rate || 0),
      net = i.taxable ?? i.amount - legacy[n];
    return { description: i.description, rate, net, gross: net + (i.tax ?? Math.round((net * rate) / 100)) };
  });
  const whole = lines.reduce((s, l) => s + l.gross, 0);
  check(whole > 0 && target > 0 && target <= whole, "The PO amount must be within the quotation total.");
  const shares = allocateDiscount(
    lines.map((l) => l.gross),
    target,
  );
  const t = lines.map((l, n) => Math.min(l.net, netFor(shares[n], l.rate)));
  const sum = () => lines.reduce((s, l, n) => s + gross(t[n], l.rate), 0);
  let short = target - sum();
  const step = (n) => gross(t[n] + 1, lines[n].rate) - gross(t[n], lines[n].rate);
  const back = (n) => gross(t[n], lines[n].rate) - gross(t[n] - 1, lines[n].rate);
  for (let guard = 0; short > 0 && guard < 10000; guard++) {
    // Add one sen to a line whose next step adds exactly one sen in total.
    const one = lines.findIndex((l, n) => t[n] < l.net && step(n) === 1);
    if (one >= 0) {
      t[one]++;
      short--;
      continue;
    }
    // Or add a step of two on one line and take one sen off another.
    let moved = false;
    for (let a = 0; a < lines.length && !moved; a++) {
      if (t[a] >= lines[a].net || step(a) !== 2) continue;
      for (let b = 0; b < lines.length && !moved; b++)
        if (b !== a && t[b] > 0 && back(b) === 1) {
          t[a]++;
          t[b]--;
          short--;
          moved = true;
        }
    }
    if (!moved) break;
  }
  const out = lines
    .map((l, n) => ({ description: l.description, net: t[n], rate: l.rate }))
    .filter((l) => l.net > 0);
  return { lines: out, total: sum() };
}
export function attachPO(Store) {
  const original = {
    invoiceFromQuote: Store.prototype.invoiceFromQuote,
    saveDocument: Store.prototype.saveDocument,
    issue: Store.prototype.issue,
    convert: Store.prototype.convert,
    void: Store.prototype.void,
    deleteDraft: Store.prototype.deleteDraft,
    sales: Store.prototype.sales,
  };
  const po = (store, pid) => {
    const row = store.db.prepare("SELECT * FROM customer_pos WHERE id=?").get(pid);
    check(row, "Customer PO not found.", 404);
    return row;
  };
  const openPOs = (store, qid) =>
    store.db
      .prepare("SELECT * FROM customer_pos WHERE quote_id=? AND status='open' ORDER BY created,id")
      .all(qid);
  const revision = (store, row, reason, changes) =>
    store.db
      .prepare(
        "INSERT INTO ops_po_revisions(po_id,revision,reference,amount,po_date,notes,status,reason,changes,actor,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.revision,
        row.reference,
        row.amount,
        row.po_date,
        row.notes,
        row.status,
        reason,
        JSON.stringify(changes),
        actor(),
        now(),
      );
  // A PO's linked invoice, unless it was voided (a void invoice bills nothing).
  const liveInvoice = (store, row) => {
    if (!row.invoice_id) return null;
    const d = store.db.prepare("SELECT id,number,state,total FROM documents WHERE id=?").get(row.invoice_id);
    return d && d.state !== "void" ? d : null;
  };
  Object.assign(Store.prototype, {
    // Several customer POs may share an accepted quotation, as long as together
    // they stay within its total (SST included).
    checkPOAmount(q, amount, exceptId = null) {
      check(Number.isSafeInteger(amount) && amount > 0, "Enter a PO amount greater than zero.");
      const others = this.db
        .prepare(
          "SELECT COALESCE(sum(amount),0) n, count(*) c FROM customer_pos WHERE quote_id=? AND status='open' AND id IS NOT ?",
        )
        .get(q.id, exceptId);
      check(
        others.n + amount <= q.total,
        `Customer POs for this quotation would total ${fmt(q, others.n + amount)}, which exceeds the quotation total of ${fmt(q, q.total)}.`,
      );
      if (others.c > 0 || amount !== q.total) {
        // A full invoice converted from the quotation leaves no room for partial POs.
        const full = this.db
          .prepare(
            "SELECT number FROM documents d WHERE source_quote=? AND state!='void' AND NOT EXISTS (SELECT 1 FROM customer_pos p WHERE p.invoice_id=d.id AND p.status='open' AND p.id IS NOT ?)",
          )
          .get(q.id, exceptId);
        check(
          !full,
          `This quotation already has a full invoice (${full?.number || "draft"}). Delete or void it before registering partial POs.`,
          409,
        );
      }
    },
    // Proposal checks (server/automation.mjs) for customer POs and PO invoices.
    checkPOProposal(kind, q, b) {
      if (kind === "customer_po") {
        check(
          !this.db
            .prepare("SELECT id FROM customer_pos WHERE client_id=? AND reference_key=?")
            .get(q.client_id, keyOf(text(b.reference, 120, true))),
          "This PO reference is already registered for this customer.",
          409,
        );
        this.checkPOAmount(q, money(b.amount));
      }
      if (kind === "invoice_from_quote" && !b.po_id)
        check(
          openPOs(this, q.id).length <= 1,
          "This quotation has several customer POs. Choose the PO to invoice (po_id).",
        );
    },
    registerPO(b) {
      return this.tx(() => {
        const q = this.document(b.quote_id);
        check(
          q.kind === "quote" && q.state === "accepted",
          "Record customer acceptance before registering the PO.",
        );
        const reference = text(b.reference, 120, true),
          reference_key = keyOf(reference),
          amount = money(b.amount),
          po_date = date(b.po_date || today());
        check(po_date <= today(), "PO cannot be future dated.");
        check(
          !this.db
            .prepare("SELECT id FROM customer_pos WHERE client_id=? AND reference_key=?")
            .get(q.client_id, reference_key),
          "This PO reference is already registered for this customer.",
          409,
        );
        this.checkPOAmount(q, amount);
        // A full-value PO adopts an invoice already issued from the quotation.
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
            amount === q.total && existing && !["draft", "void"].includes(existing.state)
              ? existing.id
              : null,
          created: now(),
          revision: 0,
          status: "open",
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO customer_pos(id,client_id,quote_id,reference,reference_key,amount,po_date,notes,invoice_id,created,revision,status,updated) VALUES(:id,:client_id,:quote_id,:reference,:reference_key,:amount,:po_date,:notes,:invoice_id,:created,:revision,:status,:updated)",
          )
          .run(out);
        revision(this, out, "Registered", []);
        this.db
          .prepare("UPDATE sales_opportunities SET stage='won',updated=? WHERE quote_id=?")
          .run(now(), q.id);
        this.audit("customer_po.received", out.id, reference, null, out);
        this.emit("customer_po.received", out.id, {
          quote_id: q.id,
          client_id: q.client_id,
        });
        return out;
      });
    },
    // Changes a PO's reference, amount, date or notes. Every change is a new
    // revision with a reason. The amount can only change while no live invoice
    // bills the PO; a draft invoice can be removed as part of the amendment.
    amendPO(pid, b) {
      return this.tx(() => {
        const old = po(this, pid);
        check(old.status === "open", "This customer PO was cancelled.", 409);
        const reason = text(b.reason, 500, true);
        const next = {
          reference: b.reference === undefined ? old.reference : text(b.reference, 120, true),
          amount: b.amount === undefined || b.amount === "" ? old.amount : money(b.amount),
          po_date: b.po_date ? date(b.po_date) : old.po_date,
          notes: b.notes === undefined ? old.notes : text(b.notes, 1000),
        };
        check(next.po_date <= today(), "PO cannot be future dated.");
        const changes = Object.keys(next).filter((k) => next[k] !== old[k]);
        check(changes.length, "Nothing changed. Edit the reference, amount, date or notes.");
        const reference_key = keyOf(next.reference);
        if (reference_key !== old.reference_key)
          check(
            !this.db
              .prepare("SELECT id FROM customer_pos WHERE client_id=? AND reference_key=? AND id!=?")
              .get(old.client_id, reference_key, pid),
            "This PO reference is already registered for this customer.",
            409,
          );
        let invoice = liveInvoice(this, old);
        if (changes.includes("amount") && invoice) {
          check(
            invoice.state === "draft",
            `This PO is already invoiced on ${invoice.number}. Raise a credit or debit note for the difference instead of changing the PO amount.`,
            409,
          );
          check(
            b.replace_draft === true || b.replace_draft === "on",
            "This PO has a draft invoice. Choose to remove the draft so a new one can be created for the new amount.",
            409,
          );
          this.deleteDraft(invoice.id);
          invoice = null;
        }
        const q = this.document(old.quote_id);
        if (changes.includes("amount")) this.checkPOAmount(q, next.amount, pid);
        if (changes.includes("reference") && invoice?.state === "draft") {
          // Keep the PO reference on the draft invoice current.
          const notes = this.db.prepare("SELECT notes FROM documents WHERE id=?").get(invoice.id).notes;
          this.db
            .prepare("UPDATE documents SET notes=?,updated=? WHERE id=?")
            .run(
              notes.replace(`Customer PO: ${old.reference}`, `Customer PO: ${next.reference}`).slice(0, 2000),
              now(),
              invoice.id,
            );
        }
        const out = {
          ...old,
          ...next,
          reference_key,
          invoice_id: this.db.prepare("SELECT invoice_id FROM customer_pos WHERE id=?").get(pid).invoice_id,
          revision: old.revision + 1,
          updated: now(),
        };
        this.db
          .prepare(
            "UPDATE customer_pos SET reference=:reference,reference_key=:reference_key,amount=:amount,po_date=:po_date,notes=:notes,revision=:revision,updated=:updated WHERE id=:id",
          )
          .run({
            id: pid,
            reference: out.reference,
            reference_key,
            amount: out.amount,
            po_date: out.po_date,
            notes: out.notes,
            revision: out.revision,
            updated: out.updated,
          });
        revision(this, out, reason, changes);
        this.audit("customer_po.amended", pid, reason, old, out);
        this.emit("customer_po.amended", pid, {
          quote_id: old.quote_id,
          client_id: old.client_id,
          revision: out.revision,
        });
        return this.db.prepare("SELECT * FROM customer_pos WHERE id=?").get(pid);
      });
    },
    // Cancels a PO that no live invoice bills, freeing its amount on the quotation.
    cancelPO(pid, b) {
      return this.tx(() => {
        const old = po(this, pid);
        check(old.status === "open", "This customer PO is already cancelled.", 409);
        const reason = text(b.reason, 500, true);
        const invoice = liveInvoice(this, old);
        if (invoice) {
          check(
            invoice.state === "draft",
            `This PO is invoiced on ${invoice.number}. Void that invoice before cancelling the PO.`,
            409,
          );
          check(
            b.replace_draft === true || b.replace_draft === "on",
            "This PO has a draft invoice. Choose to remove the draft to cancel the PO.",
            409,
          );
          this.deleteDraft(invoice.id);
        }
        const out = { ...old, status: "cancelled", revision: old.revision + 1, updated: now() };
        this.db
          .prepare("UPDATE customer_pos SET status='cancelled',revision=?,updated=? WHERE id=?")
          .run(out.revision, out.updated, pid);
        revision(this, out, reason, ["status"]);
        this.audit("customer_po.cancelled", pid, reason, old, out);
        this.emit("customer_po.cancelled", pid, { quote_id: old.quote_id, client_id: old.client_id });
        return this.db.prepare("SELECT * FROM customer_pos WHERE id=?").get(pid);
      });
    },
    invoiceFromQuote(qid, poid) {
      return this.tx(() => {
        const q = this.document(qid);
        check(q.kind === "quote" && q.state === "accepted", "Quotation must be accepted.");
        const open = openPOs(this, qid);
        let row;
        if (poid) {
          row = this.db.prepare("SELECT * FROM customer_pos WHERE id=?").get(poid);
          check(row && row.quote_id === qid, "PO does not belong to this quotation.");
          check(row.status === "open", "This customer PO was cancelled.", 409);
        } else {
          check(
            open.length <= 1,
            "This quotation has several customer POs. Choose the PO to invoice.",
          );
          row = open[0] || null;
        }
        if (!row) {
          // No PO: one full invoice from the quotation, as before.
          const existing = this.db.prepare("SELECT state FROM documents WHERE source_quote=?").get(qid);
          check(
            existing?.state !== "void",
            "The linked invoice is void. Resolve the quotation/order correction before conversion.",
          );
          return this.document(this.convert(qid).id);
        }
        if (row.amount === q.total && open.length === 1) {
          // One full-value PO keeps the original conversion (same lines and terms).
          const d = original.invoiceFromQuote.call(this, qid, row.id);
          check(
            d.total <= row.amount,
            "The invoice draft is more than the customer PO. Reduce the draft to the PO amount first.",
            409,
          );
          return d;
        }
        // A partial PO: one draft invoice for exactly this PO's amount.
        const linked = liveInvoice(this, row);
        if (linked) return this.document(linked.id);
        const full = this.db
          .prepare("SELECT number FROM documents WHERE source_quote=? AND state!='void'")
          .get(qid);
        check(
          !full,
          `This quotation already has a full invoice (${full?.number || "draft"}). Delete or void it before invoicing partial POs.`,
          409,
        );
        const scaled = scaleLines(q.items, q.discount, row.amount);
        const share = ((row.amount / q.total) * 100).toFixed(2).replace(/\.?0+$/, "");
        const suffix = ` (part, ${share}%)`;
        const note = `Customer PO: ${row.reference}. Part billing of ${fmt(q, row.amount)} against quotation ${q.number || ""} (total ${fmt(q, q.total)}).`;
        const issue = today();
        const d = this.saveDocument({
          kind: "invoice",
          client_id: q.client_id,
          issue_date: issue,
          due_date: addDays(issue, q.client.terms ?? 14),
          items: scaled.lines.map((l) => ({
            description: l.description.slice(0, 240 - suffix.length) + suffix,
            quantity: "1",
            rate: (l.net / 100).toFixed(2),
            tax_rate: l.rate,
          })),
          discount: "0",
          notes: [note, q.notes].filter(Boolean).join("\n").slice(0, 2000),
          terms: q.terms,
          ...(q.currency ? { currency: q.currency } : {}),
          ...(q.fx_rate ? { fx_rate: q.fx_rate } : {}),
          ...(q.language ? { language: q.language } : {}),
        });
        // Never more than the PO. (A sen below is possible when SST rounding cannot reach it.)
        check(d.total <= row.amount, "Could not build the partial invoice within the PO amount. Create it by hand.", 409);
        this.db
          .prepare("UPDATE customer_pos SET invoice_id=?,updated=? WHERE id=?")
          .run(d.id, now(), row.id);
        this.audit(
          "customer_po.invoiced",
          row.id,
          `${row.reference}: draft ${d.id} for ${d.total} sen`,
          row.invoice_id ? { invoice_id: row.invoice_id } : null,
          { invoice_id: d.id, total: d.total, short: row.amount - d.total },
        );
        return this.document(d.id);
      });
    },
    // A draft billed from a customer PO can be edited but never above the PO.
    saveDocument(b, idv) {
      return this.tx(() => {
        const out = original.saveDocument.call(this, b, idv);
        const row = this.db
          .prepare("SELECT reference,amount FROM customer_pos WHERE invoice_id=? AND status='open'")
          .get(out.id);
        check(
          !row || out.total <= row.amount,
          `This invoice bills customer PO ${row?.reference} for ${fmt(out, row?.amount || 0)}. Its total cannot be more than the PO.`,
          409,
        );
        return out;
      });
    },
    issue(idv) {
      return this.tx(() => {
        const d = this.db.prepare("SELECT total,state FROM documents WHERE id=?").get(idv);
        const row = this.db
          .prepare("SELECT reference,amount FROM customer_pos WHERE invoice_id=? AND status='open'")
          .get(idv);
        check(
          !row || d?.state !== "draft" || d.total <= row.amount,
          `This invoice is more than customer PO ${row?.reference}. Reduce it to the PO amount before issuing.`,
          409,
        );
        return original.issue.call(this, idv);
      });
    },
    // A quotation billed through partial POs is invoiced from its POs only.
    convert(qid) {
      const partial = this.db
        .prepare(
          "SELECT 1 FROM customer_pos p JOIN documents q ON q.id=p.quote_id WHERE p.quote_id=? AND p.status='open' AND p.amount!=q.total",
        )
        .get(qid);
      check(
        !partial,
        "This quotation is billed through partial customer POs. Create each invoice from its PO on Sales & POs.",
        409,
      );
      return original.convert.call(this, qid);
    },
    void(idv, reason) {
      const d = this.db.prepare("SELECT kind FROM documents WHERE id=?").get(idv);
      if (d?.kind === "quote")
        check(
          !openPOs(this, idv).length,
          "This quotation has customer POs. Cancel them before voiding it.",
          409,
        );
      return original.void.call(this, idv, reason);
    },
    // Deleting a PO's draft invoice frees the PO to be invoiced again.
    deleteDraft(did) {
      return this.tx(() => {
        const d = this.db.prepare("SELECT state FROM documents WHERE id=?").get(did);
        if (d?.state === "draft") {
          const rows = this.db.prepare("SELECT id,reference FROM customer_pos WHERE invoice_id=?").all(did);
          if (rows.length) {
            this.db.prepare("UPDATE customer_pos SET invoice_id=NULL,updated=? WHERE invoice_id=?").run(now(), did);
            for (const r of rows)
              this.audit("customer_po.invoice.unlinked", r.id, `${r.reference}: draft ${did} deleted`);
          }
        }
        return original.deleteDraft.call(this, did);
      });
    },
    sales() {
      const out = original.sales.call(this);
      const files = new Map(
        this.db
          .prepare("SELECT entity_id,count(*) n FROM files WHERE entity_type='customer_po' AND purpose='po_file' GROUP BY entity_id")
          .all()
          .map((r) => [r.entity_id, r.n]),
      );
      const doc = this.db.prepare("SELECT id,number,state,total FROM documents WHERE id=?");
      out.purchaseOrders = out.purchaseOrders.map((p) => {
        const q = doc.get(p.quote_id),
          inv = p.invoice_id ? doc.get(p.invoice_id) : null;
        return {
          ...p,
          quote_number: q?.number || null,
          quote_total: q?.total || 0,
          invoice_number: inv?.number || null,
          invoice_state: inv?.state || null,
          invoice_total: inv?.total ?? null,
          files: files.get(p.id) || 0,
        };
      });
      return out;
    },
    poDetail(pid) {
      const row = po(this, pid);
      const q = this.document(row.quote_id);
      const open = openPOs(this, row.quote_id);
      return {
        po: this.sales().purchaseOrders.find((p) => p.id === pid),
        quote: {
          id: q.id,
          number: q.number,
          total: q.total,
          ordered: open.reduce((s, p) => s + p.amount, 0),
          currency: q.currency || "MYR",
        },
        revisions: this.db
          .prepare("SELECT * FROM ops_po_revisions WHERE po_id=? ORDER BY revision DESC")
          .all(pid)
          .map((r) => ({ ...r, changes: JSON.parse(r.changes) })),
        files: this.files("customer_po", pid, "po_file"),
      };
    },
    savePOFile(pid, { name, data }) {
      return this.tx(() => {
        const row = po(this, pid);
        check(
          this.files("customer_po", pid, "po_file").length < MAX_PO_FILES,
          `A customer PO can hold up to ${MAX_PO_FILES} files.`,
          409,
        );
        const f = this.saveFile(
          { entity_type: "customer_po", entity_id: row.id, purpose: "po_file", name, data, visibility: "private" },
          { accept: PO_FILE_TYPES },
        );
        this.audit("customer_po.file.added", pid, f.name);
        return f;
      });
    },
  });
}
// Quotation lines rebuilt for a PO preview (used by tests and the browser hint).
export function previewPartial(q, amount) {
  const s = scaleLines(q.items, q.discount, amount);
  return calculate(
    s.lines.map((l) => ({ description: l.description, quantity: "1", rate: (l.net / 100).toFixed(2), tax_rate: l.rate })),
  );
}
