// Items used before, offered again when typing a line's title: every saved
// document's lines (the latest version of each title, per currency) and the
// catalog's services not used yet. Picking one fills the whole line.
import { detailsPlain } from "./line-details.mjs";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
// Catalog descriptions are plain text: their stars and tildes are not formatting.
const escapeMarkup = (s) => String(s).replace(/([\\*~])/g, "\\$1");

export function lineChoices(documents = [], services = []) {
  const byKey = new Map();
  const docs = [...documents].sort((a, b) => String(b.created || b.issue_date || "").localeCompare(String(a.created || a.issue_date || "")));
  for (const d of docs) {
    const priced = d.kind !== "delivery_order";
    const currency = d.currency || "MYR";
    for (const i of d.items || []) {
      // Deposit deductions are worked out by the app, not typed.
      if (i.deposit_id || !norm(i.description)) continue;
      const key = `${norm(i.description)}|${currency}`;
      const seen = byKey.get(key);
      if (seen) {
        seen.uses++;
        // A delivery order has no prices: take the rate from the latest priced use.
        if (seen.rate == null && priced) seen.rate = i.rate;
        continue;
      }
      byKey.set(key, {
        title: i.description,
        details: i.details || "",
        rate: priced ? i.rate : null,
        unit: i.unit || "",
        sku: i.sku || "",
        tax_rate: Number(i.tax_rate || 0),
        service_id: i.service_id || "",
        currency,
        uses: 1,
        last: d.issue_date || "",
        source: "past",
      });
    }
  }
  const out = [...byKey.values()];
  const titles = new Set(out.map((c) => norm(c.title)));
  for (const s of services) {
    if (s.active === 0 || s.active === false || !norm(s.name) || titles.has(norm(s.name))) continue;
    out.push({
      title: s.name,
      details: s.description && s.description !== s.name ? escapeMarkup(s.description) : "",
      rate: s.rate ?? 0,
      unit: s.unit || "",
      sku: s.sku || "",
      tax_rate: Number(s.tax_rate || 0),
      service_id: s.id,
      currency: null,
      uses: 0,
      last: "",
      source: "catalog",
    });
  }
  return out;
}

// The best matches for what is typed: titles that start with it first, then
// a word that starts with it, then anywhere in the title or the item code.
// With nothing typed, the most used and most recent items.
export function matchChoices(choices, query, { currency = "MYR", limit = 8 } = {}) {
  const q = norm(query);
  const scored = [];
  for (const c of choices) {
    if (c.currency && c.currency !== currency) continue;
    const t = norm(c.title);
    let score = 0;
    if (!q) score = 1;
    else if (t.startsWith(q)) score = 4;
    else if (t.split(" ").some((w) => w.startsWith(q))) score = 3;
    else if (t.includes(q)) score = 2;
    else if (c.sku && norm(c.sku).includes(q)) score = 2;
    else if (q.length >= 3 && norm(detailsPlain(c.details)).includes(q)) score = 1;
    if (score) scored.push([score, c]);
  }
  return scored
    .sort(([sa, a], [sb, b]) => sb - sa || b.uses - a.uses || String(b.last).localeCompare(String(a.last)) || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(([, c]) => c);
}
