// Items used before are offered again when typing a line's title.
import test from "node:test";
import assert from "node:assert/strict";
import { lineChoices, matchChoices } from "../public/ext/line-suggest.mjs";

const doc = (created, items, extra = {}) => ({ kind: "invoice", currency: "MYR", issue_date: created.slice(0, 10), created, items, ...extra });
const DOCS = [
  doc("2026-10-01T01:00:00Z", [{ description: "Corporate website", details: "Old scope", rate: 200000, tax_rate: 8 }]),
  doc("2026-10-20T01:00:00Z", [
    { description: "Corporate  Website", details: "- Up to **7 pages**", rate: 265000, tax_rate: 8, unit: "project", sku: "WEB-1" },
    { description: "Less deposit", rate: -50000, deposit_id: "x" },
  ]),
  doc("2026-10-22T01:00:00Z", [{ description: "Hosting 1 year", rate: 0 }], { kind: "delivery_order" }),
  doc("2026-10-10T01:00:00Z", [{ description: "Hosting 1 year", rate: 30000 }]),
  doc("2026-10-12T01:00:00Z", [{ description: "Website audit", rate: 9900 }], { currency: "USD" }),
];
const SERVICES = [
  { id: "s1", name: "Logo design", description: "3 concepts *incl.* revisions", rate: 80000, unit: "job", sku: "LOGO", tax_rate: 0, active: 1 },
  { id: "s2", name: "Corporate website", description: "Catalog version", rate: 100, active: 1 },
  { id: "s3", name: "Retired service", rate: 100, active: 0 },
];

test("each title once, as last used, with how often it was used; deposits and inactive services left out", () => {
  const list = lineChoices(DOCS, SERVICES);
  const web = list.find((c) => c.title === "Corporate  Website");
  assert.equal(web.details, "- Up to **7 pages**", "the latest description");
  assert.equal(web.rate, 265000, "the latest rate");
  assert.equal(web.uses, 2);
  assert.deepEqual([web.unit, web.sku, web.tax_rate], ["project", "WEB-1", 8]);
  assert.equal(list.filter((c) => /corporate\s+website/i.test(c.title)).length, 1, "the catalog's same-named service is not listed twice");
  assert.equal(list.find((c) => c.title === "Hosting 1 year").rate, 30000, "a delivery order has no price: the latest priced use gives it");
  assert.ok(!list.some((c) => c.title === "Less deposit"));
  assert.ok(!list.some((c) => c.title === "Retired service"));
  const logo = list.find((c) => c.title === "Logo design");
  assert.equal(logo.source, "catalog");
  assert.equal(logo.details, "3 concepts \\*incl.\\* revisions", "catalog text is not formatting");
  assert.equal(logo.service_id, "s1");
});

test("typing finds titles that start with it first, then words, then codes; other currencies stay out", () => {
  const list = lineChoices(DOCS, SERVICES);
  assert.deepEqual(
    matchChoices(list, "web").map((c) => c.title),
    ["Corporate  Website"],
    "a word starting with it; the USD line is not offered on a ringgit document",
  );
  assert.deepEqual(
    matchChoices(list, "web", { currency: "USD" }).map((c) => c.title),
    ["Website audit"],
  );
  assert.deepEqual(
    matchChoices(list, "logo").map((c) => c.title),
    ["Logo design"],
  );
  assert.deepEqual(
    matchChoices(list, "web-1").map((c) => c.title),
    ["Corporate  Website"],
    "by item code",
  );
  assert.deepEqual(
    matchChoices(list, "pages").map((c) => c.title),
    ["Corporate  Website"],
    "by description, from 3 letters",
  );
  assert.deepEqual(matchChoices(list, "zzz"), []);
  // Nothing typed: the most used first, then the most recent.
  assert.deepEqual(
    matchChoices(list, "")
      .slice(0, 3)
      .map((c) => c.title),
    ["Hosting 1 year", "Corporate  Website", "Logo design"],
  );
  assert.equal(matchChoices(list, "", { limit: 2 }).length, 2);
});

test("an item last used on a delivery order keeps the SST of its latest priced use", () => {
  const list = lineChoices(
    [
      doc("2026-10-22T01:00:00Z", [{ description: "Router", rate: 0, tax_rate: 0 }], { kind: "delivery_order" }),
      doc("2026-10-10T01:00:00Z", [{ description: "Router", rate: 10000, tax_rate: 8 }]),
    ],
    [],
  );
  assert.deepEqual([list[0].rate, list[0].tax_rate], [10000, 8]);
  // Used only on delivery orders: no price known, no SST.
  const only = lineChoices([doc("2026-10-22T01:00:00Z", [{ description: "Cable", rate: 0 }], { kind: "delivery_order" })], []);
  assert.deepEqual([only[0].rate, only[0].tax_rate], [null, 0]);
});
