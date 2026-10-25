// What changed in a document, in words, from the before and after copies the
// audit history keeps for each save (server/finance.mjs, saveDocument).
// Used by the Activity panel, which only the owner sees.
const amount = (sen) =>
  (Number(sen || 0) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const short = (s, n = 40) => {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const qty = (q) => String(Number(q || 0));
const quoted = (s) => `“${short(s)}”`;
// Deposit deductions are worked out by the app, not typed: they are not compared.
const typed = (items) => (Array.isArray(items) ? items.filter((i) => i && !i.deposit_id) : []);

// Lines are paired by title (same place first), then by place for a title
// that was retyped. What is left over was added or removed.
function pairLines(before, after) {
  const pairs = [];
  const usedA = new Set(),
    usedB = new Set();
  const pair = (i, j) => {
    pairs.push([i, j]);
    usedA.add(i);
    usedB.add(j);
  };
  before.forEach((line, i) => {
    if (after[i] && norm(after[i].description) === norm(line.description)) pair(i, i);
  });
  before.forEach((line, i) => {
    if (usedA.has(i)) return;
    const j = after.findIndex((b, k) => !usedB.has(k) && norm(b.description) === norm(line.description));
    if (j >= 0) pair(i, j);
  });
  before.forEach((_, i) => {
    if (!usedA.has(i) && i < after.length && !usedB.has(i)) pair(i, i);
  });
  return {
    pairs: pairs.sort((x, y) => x[1] - y[1]),
    added: after.map((_, j) => j).filter((j) => !usedB.has(j)),
    removed: before.map((_, i) => i).filter((i) => !usedA.has(i)),
  };
}

function lineChanges(a, b) {
  const out = [];
  if (norm(a.description) !== norm(b.description)) out.push(`title ${quoted(a.description)} → ${quoted(b.description)}`);
  if (Number(a.quantity) !== Number(b.quantity)) out.push(`quantity ${qty(a.quantity)} → ${qty(b.quantity)}`);
  if ((a.rate || 0) !== (b.rate || 0)) out.push(`rate ${amount(a.rate)} → ${amount(b.rate)}`);
  if ((a.discount || 0) !== (b.discount || 0)) out.push(`discount ${amount(a.discount)} → ${amount(b.discount)}`);
  if (Number(a.tax_rate || 0) !== Number(b.tax_rate || 0)) out.push(`SST ${Number(a.tax_rate || 0)}% → ${Number(b.tax_rate || 0)}%`);
  if ((a.details || "") !== (b.details || "")) out.push(!a.details ? "description added" : !b.details ? "description removed" : "description changed");
  if ((a.unit || "") !== (b.unit || "")) out.push(`unit ${quoted(a.unit || "—")} → ${quoted(b.unit || "—")}`);
  if ((a.sku || "") !== (b.sku || "")) out.push(`code ${quoted(a.sku || "—")} → ${quoted(b.sku || "—")}`);
  return out;
}

// before/after: { client_id, items, issue_date, due_date, total, discount, notes, terms }.
export function documentChanges(before, after, { clientName = (id) => id, date = (d) => d, dueLabel = "Due date" } = {}) {
  if (!after) return [];
  const itemsAfter = typed(after.items);
  if (!before) return [`Created with ${itemsAfter.length} line${itemsAfter.length === 1 ? "" : "s"}, total ${amount(after.total)}`];
  const out = [];
  if (before.client_id !== after.client_id) out.push(`Client: ${clientName(before.client_id)} → ${clientName(after.client_id)}`);
  if (before.issue_date !== after.issue_date) out.push(`Issue date: ${date(before.issue_date)} → ${date(after.issue_date)}`);
  if (before.due_date !== after.due_date) out.push(`${dueLabel}: ${date(before.due_date)} → ${date(after.due_date)}`);
  const itemsBefore = typed(before.items);
  const { pairs, added, removed } = pairLines(itemsBefore, itemsAfter);
  for (const [i, j] of pairs) {
    const c = lineChanges(itemsBefore[i], itemsAfter[j]);
    if (c.length) out.push(`Line ${j + 1} ${quoted(itemsBefore[i].description)}: ${c.join(", ")}`);
  }
  for (const j of added) {
    const l = itemsAfter[j];
    out.push(`Added line ${j + 1} ${quoted(l.description)}: ${qty(l.quantity)} × ${amount(l.rate)}`);
  }
  for (const i of removed) {
    const l = itemsBefore[i];
    out.push(`Removed line ${quoted(l.description)} (${qty(l.quantity)} × ${amount(l.rate)})`);
  }
  if ((before.discount || 0) !== (after.discount || 0)) out.push(`Document discount: ${amount(before.discount)} → ${amount(after.discount)}`);
  if (norm(before.terms) !== norm(after.terms)) out.push("Terms and conditions changed");
  if (norm(before.notes) !== norm(after.notes)) out.push("Notes changed");
  if ((before.total || 0) !== (after.total || 0)) out.push(`Total: ${amount(before.total)} → ${amount(after.total)}`);
  return out;
}

// An audit row's changes, when it is a document save that kept both copies.
export function auditChanges(row, options) {
  if (!["draft.changed", "document.revised"].includes(row?.action)) return null;
  const parse = (s) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  const after = parse(row.after_data);
  if (!after) return null;
  return documentChanges(parse(row.before_data), after, options);
}
