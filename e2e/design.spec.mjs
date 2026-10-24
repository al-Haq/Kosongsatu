import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

test("the Soft design is a per-browser choice; client links keep the classic look", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-design", "soft");
  // Switching keeps what is typed in an unsaved form.
  await page.goto("/#/settings");
  const company = page.locator('form[data-form="settings"] input[name=company]');
  await company.fill("Unsaved name Sdn Bhd");
  await page.click('.design-switch [data-id="soft"]');
  await expect(html).toHaveAttribute("data-design", "soft");
  await expect(company).toHaveValue("Unsaved name Sdn Bhd");
  await expect(page.locator('.design-switch [data-id="soft"]')).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Plus Jakarta Sans");
  // The overview's comparisons and charts are there in either design.
  await page.goto("/#/overview");
  await expect(page.locator(".metric.hero")).toBeVisible();
  await expect(page.locator("svg.trend")).toBeVisible();
  await expect(page.locator(".aging-panel")).toBeVisible();

  // The choice survives a reload, and every page opens in it.
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(html).toHaveAttribute("data-design", "soft");
  const links = await page.locator(".sidebar nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  for (const href of links) {
    await page.goto("/" + href);
    await expect(page.locator("main h1").first(), href).toBeVisible();
  }

  // A client link opened in the same browser keeps the classic look.
  const client = unique("Design Client");
  await createClient(page, client);
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Design check");
  await editor.locator(".item-rate").first().fill("100.00");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await page.click('[data-action="issue-document"]');
  await page.click('[data-action="confirm-issue"]');
  await expect(page.locator("#toast")).toContainText("Document issued");
  const number = (await page.locator("main h1").first().textContent()).trim();
  await page.click('[data-action="share-document"]');
  await page.click('[data-action="generate-link"]');
  const link = await page.locator("input[name=shareurl]").inputValue();
  await page.goto(link);
  await expect(page.locator("h1")).toContainText(number);
  await expect(html).not.toHaveAttribute("data-design", "soft");

  // Back in the workspace the choice still holds, and Classic switches it off.
  await page.goto("/#/overview");
  await expect(html).toHaveAttribute("data-design", "soft");
  await page.click('.design-switch [data-id="classic"]');
  await expect(html).not.toHaveAttribute("data-design", "soft");
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(html).not.toHaveAttribute("data-design", "soft");
  expect(errors).toEqual([]);
});
