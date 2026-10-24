import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

test("overview: month comparisons, 12-week collections and aging; the menu marks the current page", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/#/overview");
  // The first row of cards (other modules add their own further down).
  const cards = page.locator(".metrics").first();
  await expect(cards.locator(".metric")).toHaveCount(4);
  await expect(cards.locator("svg.spark")).toHaveCount(2);
  await expect(cards.locator("svg.mini-aging")).toHaveCount(1);
  await expect(page.locator("svg.trend")).toBeVisible();
  // One tooltip target per week.
  await expect(page.locator("svg.trend rect.hit")).toHaveCount(12);
  await expect(page.locator(".trend-axis")).toContainText("Today");
  await expect(page.locator(".aging-panel h2")).toHaveText("Aging");
  // The current page in the left menu is a black pill with white text.
  const active = page.locator('.sidebar nav a[aria-current="page"]');
  await expect(active).toHaveText("Overview");
  expect(await active.evaluate((a) => [getComputedStyle(a).backgroundColor, getComputedStyle(a).color])).toEqual(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]);
  await page.goto("/#/invoices");
  await expect(page.locator('.sidebar nav a[aria-current="page"]')).toHaveText("Invoices");
  expect(errors).toEqual([]);
});

test("overview: an invoice with a missed instalment counts as late from that instalment", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("Instalment Client");
  await createClient(page, client);
  const dmy = (days) => {
    const d = new Date(Date.now() + days * 86400000);
    return { iso: d.toISOString().slice(0, 10), text: d.toISOString().slice(0, 10).split("-").reverse().join("/") };
  };
  // Issued 200 days ago, due in 60 days, but split so the first half was due 190 days ago.
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator("input[name=issue_date]").fill(dmy(-200).text);
  await editor.locator("input[name=due_date]").fill(dmy(60).text);
  await editor.locator(".item-description").first().fill("Fit-out works");
  await editor.locator(".item-rate").first().fill("100.00");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await expect(page.locator("#toast")).toContainText("Document issued");
  const number = (await page.locator("main h1").first().textContent()).trim();
  const id = await page.evaluate((n) => fetch("/api/workspace").then((r) => r.json()).then((w) => w.documents.find((d) => d.number === n).id), number);
  const status = await page.evaluate(
    async ({ id, first, last }) => {
      const s = await (await fetch("/api/session")).json();
      const r = await fetch(`/api/ext/documents/${id}/instalments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf },
        body: JSON.stringify({ instalments: [{ due_date: first, amount: "50.00" }, { due_date: last, amount: "50.00" }] }),
      });
      return r.status;
    },
    { id, first: dmy(-190).iso, last: dmy(30).iso },
  );
  expect(status).toBe(200);
  await page.goto("/#/overview");
  await page.reload();
  const row = page.locator(".attention", { hasText: number });
  await expect(row.locator(".badge")).toContainText("Overdue");
  await expect(row.locator(".late-chip")).toContainText(/^(18[5-9]|19[0-5]) days late$/);
  expect(errors).toEqual([]);
});
