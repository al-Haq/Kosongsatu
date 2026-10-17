// Small helpers shared by the payment providers.
// "1,234.50" or 1234.5 -> 123450 sen; anything else -> NaN.
export function rmToSen(value) {
  const s = String(value ?? "").replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return NaN;
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
// 123450 -> "1234.50" (or "1,234.50" with thousands separators).
export function senToRm(sen, thousands = false) {
  const whole = Math.floor(sen / 100),
    cents = String(sen % 100).padStart(2, "0");
  const w = thousands ? whole.toLocaleString("en-US") : String(whole);
  return `${w}.${cents}`;
}
// Calendar date in Kuala Lumpur for a Unix time in seconds (or a Date).
export function klDate(value) {
  const d = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(d.valueOf())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
// Stripe-style nested form encoding: { a: { b: [1] } } -> a[b][0]=1
export function formEncode(value, prefix = "", out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else out.append(prefix, String(value));
  return out;
}
// "17-10-2026 10:15:00", "2026-10-17 10:15:00" or ISO -> "2026-10-17".
export function looseDate(value) {
  const s = String(value || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
