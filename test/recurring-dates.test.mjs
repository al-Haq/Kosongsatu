import test from "node:test";
import assert from "node:assert/strict";
import {
  stepPeriod,
  addMonths,
  periodLabel,
  frequencyOf,
  frequencyLabel,
  monthRange,
  previousMonth,
  daysBetween,
} from "../server/recurring-dates.mjs";
import { termEnd, contractStatus } from "../server/recurring-contracts.mjs";

const walk = (start, plan, n) => {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(stepPeriod(out[i - 1], plan));
  return out;
};

test("monthly plans keep the anchor day through short months and leap years", () => {
  const plan = { unit: "month", interval: 1, anchor_day: 31 };
  assert.deepEqual(walk("2026-01-31", plan, 4), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(walk("2028-01-31", plan, 3), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  assert.deepEqual(walk("2026-01-30", { ...plan, anchor_day: 30 }, 3), ["2026-01-30", "2026-02-28", "2026-03-30"]);
  // Month end follows the last day, even when the plan started on the 30th.
  assert.deepEqual(walk("2026-04-30", { ...plan, anchor_day: 30, month_end: 1 }, 3), [
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
  ]);
  assert.equal(stepPeriod("2026-12-15", { unit: "month", interval: 1, anchor_day: 15 }), "2027-01-15");
});

test("quarterly, six-monthly and yearly plans step by months with the same rules", () => {
  assert.deepEqual(walk("2026-11-30", { unit: "month", interval: 3, anchor_day: 30 }, 4), [
    "2026-11-30",
    "2027-02-28",
    "2027-05-30",
    "2027-08-30",
  ]);
  assert.deepEqual(walk("2027-11-30", { unit: "month", interval: 3, anchor_day: 30 }, 2), ["2027-11-30", "2028-02-29"]);
  assert.deepEqual(walk("2026-08-31", { unit: "month", interval: 6, anchor_day: 31 }, 3), [
    "2026-08-31",
    "2027-02-28",
    "2027-08-31",
  ]);
  assert.deepEqual(walk("2028-02-29", { unit: "month", interval: 12, anchor_day: 29 }, 5), [
    "2028-02-29",
    "2029-02-28",
    "2030-02-28",
    "2031-02-28",
    "2032-02-29",
  ]);
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
});

test("weekly plans step by 7 or 14 days across month and year ends", () => {
  assert.deepEqual(walk("2026-12-24", { unit: "week", interval: 1 }, 3), ["2026-12-24", "2026-12-31", "2027-01-07"]);
  assert.deepEqual(walk("2028-02-22", { unit: "week", interval: 2 }, 3), ["2028-02-22", "2028-03-07", "2028-03-21"]);
  // Week plans ignore month-end settings.
  assert.equal(stepPeriod("2026-01-31", { unit: "week", interval: 1, month_end: 1, anchor_day: 31 }), "2026-02-07");
});

test("service period labels name the month, months or exact days", () => {
  assert.equal(periodLabel("2026-11-01", { unit: "month", interval: 1 }), "Nov 2026");
  assert.equal(periodLabel("2026-01-31", { unit: "month", interval: 3 }), "Jan – Mar 2026");
  assert.equal(periodLabel("2026-11-15", { unit: "month", interval: 3 }), "Nov 2026 – Jan 2027");
  assert.equal(periodLabel("2026-11-01", { unit: "month", interval: 12 }), "Nov 2026 – Oct 2027");
  assert.equal(periodLabel("2026-11-02", { unit: "week", interval: 1 }), "2–8 Nov 2026");
  assert.equal(periodLabel("2026-10-28", { unit: "week", interval: 1 }), "28 Oct – 3 Nov 2026");
  assert.equal(periodLabel("2026-12-29", { unit: "week", interval: 2 }), "29 Dec 2026 – 11 Jan 2027");
});

test("frequencies accept the six presets or a unit and interval, nothing else", () => {
  assert.deepEqual(frequencyOf({ frequency: "biweekly" }), { unit: "week", interval: 2 });
  assert.deepEqual(frequencyOf({ frequency: "semiannual" }), { unit: "month", interval: 6 });
  assert.deepEqual(frequencyOf({}), { unit: "month", interval: 1 });
  assert.deepEqual(frequencyOf({ unit: "month", interval: "2" }), { unit: "month", interval: 2 });
  assert.throws(() => frequencyOf({ frequency: "daily" }), /Choose weekly/);
  assert.throws(() => frequencyOf({ unit: "week", interval: 5 }), /1 to 4 weeks/);
  assert.throws(() => frequencyOf({ unit: "month", interval: 0 }), /1 to 12 months/);
  assert.throws(() => frequencyOf({ unit: "day", interval: 1 }));
  assert.equal(frequencyLabel("month", 3), "Quarterly");
  assert.equal(frequencyLabel("month", 2), "Every 2 months");
});

test("month ranges, contract terms and status windows", () => {
  assert.deepEqual(monthRange("2028-02"), { month: "2028-02", from: "2028-02-01", to: "2028-02-29", label: "Feb 2028" });
  assert.throws(() => monthRange("2026-13"), /YYYY-MM/);
  assert.throws(() => monthRange("2026-1"), /YYYY-MM/);
  assert.equal(previousMonth("2026-01-05"), "2025-12");
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 3);
  assert.equal(termEnd("2027-01-01", 12), "2027-12-31");
  assert.equal(termEnd("2026-01-31", 1), "2026-02-28");
  assert.equal(termEnd("2026-01-28", 1), "2026-02-27");
  assert.equal(termEnd("2028-03-01", 12), "2029-02-28");
  const c = { status: "active", end_date: "2026-11-30", notice_days: 30 };
  assert.equal(contractStatus(c, "2026-10-01"), "active");
  assert.equal(contractStatus(c, "2026-11-01"), "expiring");
  assert.equal(contractStatus(c, "2026-12-01"), "ended");
  assert.equal(contractStatus({ ...c, status: "cancelled" }, "2026-10-01"), "cancelled");
});
