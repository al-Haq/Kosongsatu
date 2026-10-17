// Date stepping for recurring plans, contracts and monthly reports.
// Dates are plain "YYYY-MM-DD" strings (Kuala Lumpur calendar days).
import { check, addDays } from "./domain.mjs";

// The frequencies the owner can choose. A plan stores unit + interval.
export const FREQUENCIES = {
  weekly: { unit: "week", interval: 1, label: "Weekly" },
  biweekly: { unit: "week", interval: 2, label: "Every 2 weeks" },
  monthly: { unit: "month", interval: 1, label: "Monthly" },
  quarterly: { unit: "month", interval: 3, label: "Quarterly" },
  semiannual: { unit: "month", interval: 6, label: "Every 6 months" },
  yearly: { unit: "month", interval: 12, label: "Yearly" },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Accepts { frequency: "quarterly" } or { unit: "month", interval: 3 }.
export function frequencyOf(b = {}, fallback = FREQUENCIES.monthly) {
  if (b.frequency !== undefined && b.frequency !== null && b.frequency !== "") {
    const f = FREQUENCIES[b.frequency];
    check(f, "Choose weekly, every 2 weeks, monthly, quarterly, every 6 months or yearly.");
    return { unit: f.unit, interval: f.interval };
  }
  if (b.unit === undefined && b.interval === undefined) return { unit: fallback.unit, interval: fallback.interval };
  const unit = b.unit ?? fallback.unit,
    interval = Number(b.interval ?? fallback.interval);
  check(["week", "month"].includes(unit), "Choose a weekly or monthly frequency.");
  check(
    Number.isInteger(interval) && interval >= 1 && interval <= (unit === "week" ? 4 : 12),
    unit === "week" ? "Repeat every 1 to 4 weeks." : "Repeat every 1 to 12 months.",
  );
  return { unit, interval };
}
export function frequencyKey(unit, interval) {
  return Object.entries(FREQUENCIES).find(([, f]) => f.unit === unit && f.interval === interval)?.[0] || null;
}
export function frequencyLabel(unit, interval) {
  const key = frequencyKey(unit, interval);
  if (key) return FREQUENCIES[key].label;
  return `Every ${interval} ${unit}${interval === 1 ? "" : "s"}`;
}
const parts = (value) => value.split("-").map(Number);
const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// Months forward, keeping the anchor day (31 Jan -> 28/29 Feb -> 31 Mar) or the month end.
export function addMonths(value, n, anchorDay = null, monthEnd = false) {
  const [y, m, d] = parts(value);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12),
    nm = (total % 12) + 1;
  const end = lastDay(ny, nm);
  return iso(ny, nm, monthEnd ? end : Math.min(anchorDay ?? d, end));
}
// The billing date after `value` for a plan.
export function stepPeriod(value, { unit = "month", interval = 1, anchor_day = null, month_end = 0 } = {}) {
  if (unit === "week") return addDays(value, 7 * interval);
  return addMonths(value, interval, anchor_day, !!month_end);
}
export function daysBetween(from, to) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}
const monthLabel = (y, m) => `${MONTHS[m - 1]} ${y}`;
export function dayLabel(value) {
  const [y, m, d] = parts(value);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// Text for a service period, e.g. "Nov 2026", "Nov 2026 – Jan 2027" or "2–8 Nov 2026".
export function periodLabel(start, plan) {
  const unit = plan.unit || "month",
    interval = plan.interval || 1;
  const [y, m, d] = parts(start);
  if (unit === "month") {
    if (interval === 1) return monthLabel(y, m);
    const [ey, em] = parts(addMonths(iso(y, m, 1), interval - 1));
    return ey === y ? `${MONTHS[m - 1]} – ${monthLabel(ey, em)}` : `${monthLabel(y, m)} – ${monthLabel(ey, em)}`;
  }
  const [ey, em, ed] = parts(addDays(stepPeriod(start, plan), -1));
  if (ey === y && em === m) return `${d}–${ed} ${monthLabel(y, m)}`;
  if (ey === y) return `${d} ${MONTHS[m - 1]} – ${ed} ${monthLabel(ey, em)}`;
  return `${dayLabel(start)} – ${dayLabel(iso(ey, em, ed))}`;
}
// "2026-10" -> { from: "2026-10-01", to: "2026-10-31", label: "Oct 2026" }.
export function monthRange(month) {
  check(typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month), "Choose a month (YYYY-MM).");
  const [y, m] = parts(month);
  return { month, from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)), label: monthLabel(y, m) };
}
export function previousMonth(day) {
  return addMonths(day.slice(0, 7) + "-01", -1).slice(0, 7);
}
