// Suggests which open invoices (or already recorded receipts) an unmatched bank
// credit most likely belongs to, with a score and plain reasons. Nothing is
// recorded here; the owner confirms each suggestion.
const SEP = "[\\s\\-/_.#:]*";
const DAY = 86400000;
export const normalize = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
const compact = (s) => normalize(s).replace(/ /g, "");
// Words that say nothing about who paid.
const NAME_STOP = new Set(
  "SDN BHD BERHAD PLT ENTERPRISE ENTERPRISES TRADING RESOURCES SERVICES SERVICE SOLUTION SOLUTIONS SYSTEM SYSTEMS COMPANY CO THE AND DAN OF GROUP HOLDINGS HOLDING INDUSTRIES INTERNATIONAL GLOBAL MALAYSIA LTD LIMITED INC LLP DEMO TECHNOLOGY TECHNOLOGIES TECH CORP CORPORATION KL CONSULTING MANAGEMENT AGENCY STUDIO DIGITAL"
    .split(" "),
);
// Patterns for an invoice number as people and banks mangle it:
// INV-2026-0012 -> "INV2026 12", "inv-2026-0012", "INV 2026/012", "2026-0012", "INV12".
export function numberPatterns(number) {
  const parts = String(number || "").match(/[A-Za-z]+|\d+/g);
  if (!parts) return null;
  const letters = parts.filter((p) => /^[A-Za-z]/.test(p));
  const digits = parts.filter((p) => /^\d/.test(p));
  if (!digits.length) return null;
  const num = (d) => "0*" + d.replace(/^0+(?=\d)/, "");
  const seq = digits.map(num).join(SEP);
  const prefix = letters.map((l) => l.replace(/[^A-Za-z]/g, "")).join(SEP);
  return {
    full: prefix ? new RegExp(`${prefix}${SEP}${seq}(?![\\d])`, "i") : null,
    digits: digits.length > 1 ? new RegExp(`(?<![\\d])${seq}(?![\\d:])`) : null,
    short: prefix && digits.length > 1 ? new RegExp(`(?<![A-Z])${prefix}${SEP}${num(digits.at(-1))}(?![\\d])`, "i") : null,
  };
}
export function nameTokens(name) {
  return [...new Set(normalize(name).split(" "))].filter((t) => t.length >= 3 && !NAME_STOP.has(t) && !/^\d+$/.test(t));
}
// Which of the client's distinctive name words appear in the bank text, allowing
// for banks that cut names short ("MERANTI DIGI") or glue words together.
export function nameMatch(name, text) {
  const tokens = nameTokens(name);
  if (!tokens.length) return { share: 0, found: [] };
  const words = normalize(text).split(" ").filter(Boolean),
    glued = compact(text);
  const found = tokens.filter(
    (t) =>
      words.includes(t) ||
      words.some((w) => w.length >= 4 && t.startsWith(w)) ||
      (t.length >= 5 && glued.includes(t)),
  );
  return { share: found.length / tokens.length, found };
}
const days = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY);
const rm = (sen) => "RM " + (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Number, name, proof and date signals shared by single and combined suggestions.
function signals(t, inv, proofs) {
  const textAll = `${t.reference} ${t.description}`;
  const reasons = [];
  let score = 0,
    numberHit = false,
    proof = null;
  const p = numberPatterns(inv.number);
  if (p) {
    const m = (p.full && textAll.match(p.full)) || null;
    const d = !m && p.digits ? textAll.match(p.digits) : null;
    const s = !m && !d && p.short ? textAll.match(p.short) : null;
    if (m) {
      score += 50;
      numberHit = true;
      reasons.push(
        compact(m[0]) === compact(inv.number) && normalize(m[0]) === normalize(inv.number)
          ? `Invoice number ${inv.number} is in the bank text`
          : `Invoice number ${inv.number} appears as "${m[0].trim()}"`,
      );
    } else if (d) {
      score += 30;
      numberHit = true;
      reasons.push(`"${d[0].trim()}" looks like invoice ${inv.number}`);
    } else if (s) {
      score += 22;
      numberHit = true;
      reasons.push(`"${s[0].trim()}" may be invoice ${inv.number}`);
    }
  }
  const name = nameMatch(inv.client_name, textAll);
  if (name.share > 0) {
    score += Math.round(30 * name.share);
    reasons.push(`Client name matches "${name.found.join(" ")}"`);
  }
  const ref = compact(t.reference) + " " + compact(t.description);
  for (const pr of proofs.filter((x) => x.invoice_id === inv.id)) {
    const c = compact(pr.reference);
    if (c.length >= 4 && ref.includes(c)) {
      score += 35;
      proof = pr.id;
      reasons.push(`The client submitted reference "${pr.reference}"`);
      break;
    }
  }
  if (inv.issue_date && days(t.txn_date, inv.issue_date) < -3) {
    score -= 15;
    reasons.push("Paid before the invoice was issued");
  } else if (inv.due_date) {
    const gap = days(t.txn_date, inv.due_date);
    if (Math.abs(gap) <= 3) {
      score += 10;
      reasons.push(gap === 0 ? "Paid on the due date" : `Paid ${Math.abs(gap)} day(s) ${gap < 0 ? "before" : "after"} the due date`);
    } else if (gap >= -21 && gap <= 21) {
      score += 6;
      reasons.push(`Paid ${Math.abs(gap)} days ${gap < 0 ? "before" : "after"} the due date`);
    } else if (gap > 21 && gap <= 60) score += 3;
  }
  return { score, reasons, numberHit, nameShare: name.share, proof };
}
const label = (score) => (score >= 70 ? "High" : score >= 40 ? "Medium" : "Low");
// Small subsets of one client's open invoices that add up to the bank amount.
function combos(list, amount) {
  const items = list.slice(0, 12);
  let best = null;
  const walk = (start, chosen, sum) => {
    if (best && chosen.length >= best.length) return;
    if (sum === amount && chosen.length >= 2) best = [...chosen];
    if (chosen.length === 4 || sum >= amount) return;
    for (let i = start; i < items.length; i++) walk(i + 1, [...chosen, items[i]], sum + items[i].balance);
  };
  walk(0, [], 0);
  return best;
}
// t: { amount, reference, description, txn_date, account }
// data: { invoices: [{ id, number, client_id, client_name, balance, total, issue_date, due_date }],
//         receipts: [{ id, number, amount, account, reference, client_id, client_name, paid_date }],
//         proofs: [{ id, invoice_id, reference }] }
export function suggestMatches(t, { invoices = [], receipts = [], proofs = [] }, { limit = 3, min = 25 } = {}) {
  if (!(t.amount > 0)) return [];
  const out = [];
  for (const inv of invoices) {
    if (!(inv.balance > 0)) continue;
    const s = signals(t, inv, proofs);
    let score = s.score;
    const reasons = [...s.reasons];
    let allocate = Math.min(t.amount, inv.balance);
    if (t.amount === inv.balance) {
      score += 45;
      reasons.unshift(`Amount equals the open balance (${rm(inv.balance)})`);
    } else if (t.amount < inv.balance) {
      if (!(s.numberHit || s.nameShare > 0 || s.proof)) continue;
      score += 8;
      reasons.push(`Could be a part payment (${rm(t.amount)} of ${rm(inv.balance)})`);
    } else {
      if (!(s.numberHit || s.proof)) continue;
      score += 3;
      reasons.push(`More than the balance; ${rm(t.amount - inv.balance)} would stay as customer funds`);
    }
    out.push({
      kind: "invoice",
      score,
      reasons,
      client_id: inv.client_id,
      client_name: inv.client_name,
      invoices: [{ id: inv.id, number: inv.number, balance: inv.balance, allocate }],
      proof_id: s.proof,
    });
  }
  // Several invoices of one client paid together.
  const byClient = new Map();
  for (const inv of invoices) if (inv.balance > 0 && inv.balance < t.amount) byClient.set(inv.client_id, [...(byClient.get(inv.client_id) || []), inv]);
  for (const list of byClient.values()) {
    if (list.length < 2) continue;
    const set = combos(list, t.amount);
    if (!set) continue;
    const sig = set.map((inv) => signals(t, inv, proofs));
    const hits = sig.filter((x) => x.numberHit).length;
    const score =
      42 +
      Math.min(40, hits * 20) +
      Math.round(30 * Math.max(...sig.map((x) => x.nameShare))) +
      (sig.some((x) => x.proof) ? 35 : 0);
    out.push({
      kind: "invoices",
      score,
      reasons: [
        `Amount equals ${set.map((i) => i.number).join(" + ")} (${rm(t.amount)})`,
        ...[...new Set(sig.flatMap((x) => x.reasons).filter((r) => !/due date|before the invoice/.test(r)))],
      ],
      client_id: set[0].client_id,
      client_name: set[0].client_name,
      invoices: set.map((i) => ({ id: i.id, number: i.number, balance: i.balance, allocate: i.balance })),
      proof_id: sig.find((x) => x.proof)?.proof || null,
    });
  }
  // A receipt already recorded by hand for this money: match it, never record it twice.
  for (const r of receipts) {
    if (r.amount !== t.amount || String(r.account).toUpperCase() !== t.account) continue;
    let score = 50;
    const reasons = [`Receipt ${r.number} (${r.client_name}) has the same amount and account`];
    const a = compact(r.reference),
      b = compact(t.reference) + compact(t.description);
    if (a.length >= 4 && b.includes(a)) {
      score += 30;
      reasons.push(`Same reference "${r.reference}"`);
    }
    const gap = Math.abs(days(t.txn_date, r.paid_date));
    if (gap <= 3) {
      score += 15;
      reasons.push(gap === 0 ? "Same date" : `Dates ${gap} day(s) apart`);
    } else if (gap > 14) score -= 20;
    out.push({ kind: "receipt", score, reasons, client_id: r.client_id, client_name: r.client_name, receipt_id: r.id, receipt_number: r.number, invoices: [] });
  }
  out.sort((x, y) => y.score - x.score);
  const kept = out.filter((s) => s.score >= min).slice(0, limit);
  // Two equally good answers are a hard case: say so and lower the confidence.
  if (kept.length > 1 && kept[0].score - kept[1].score < 8) for (const s of kept) (s.ambiguous = true), (s.score -= 15);
  return kept.map((s) => ({ ...s, score: Math.max(1, Math.min(99, s.score)), confidence: label(s.score) }));
}
