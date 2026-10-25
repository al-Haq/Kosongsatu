import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

// A line has a title, and under it a description with bold, italic,
// strikethrough and lists, shown on the document and kept when edited again.
test("line items: title with a formatted description", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Details");
  await createClient(page, client);

  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  const row = editor.locator(".line-item").first();
  await row.locator(".item-description").fill("Corporate website");
  await row.locator(".item-rate").fill("2650");
  await expect(row.locator(".line-details")).toBeHidden();
  await row.locator('[data-details="add"]').click();
  const box = row.locator(".item-details");
  await expect(box).toBeFocused();
  await page.keyboard.type("Design and build, ");
  await row.locator('[data-fmt="bold"]').click();
  await page.keyboard.type("up to 7 pages");
  await row.locator('[data-fmt="bold"]').click();
  await page.keyboard.press("Enter");
  await row.locator('[data-fmt="insertUnorderedList"]').click();
  await page.keyboard.type("Content and copywriting");
  await page.keyboard.press("Enter");
  await page.keyboard.type("WhatsApp and Google Maps");
  // Pasted text arrives without its formatting.
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/html", "<b style='color:red'>pasted</b>");
    data.setData("text/plain", " (pasted)");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box.locator("[style]")).toHaveCount(0);
  await expect(row.locator(".details-count")).toContainText("/ 3000");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");

  // The document shows the title, then the formatted description.
  const cell = page.locator(".quote-scope").first();
  await expect(cell).toContainText("Corporate website");
  await expect(cell.locator(".line-details-view strong")).toHaveText("up to 7 pages");
  await expect(cell.locator(".line-details-view li")).toHaveText(["Content and copywriting", "WhatsApp and Google Maps (pasted)"]);
  await expect(cell.locator(".line-details-view b")).toHaveCount(0);

  // Editing again keeps the description, and it can be removed.
  await page.click('[data-action="edit-document"]');
  const again = page.locator('form[data-form="editor"] .line-item').first();
  await expect(again.locator(".line-details")).toBeVisible();
  await expect(again.locator(".item-details strong")).toHaveText("up to 7 pages");
  await expect(again.locator(".item-details li")).toHaveCount(2);
  await page.locator('form[data-form="editor"] button[type=submit]').click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await expect(page.locator(".quote-scope .line-details-view li")).toHaveCount(2);

  await page.click('[data-action="edit-document"]');
  const last = page.locator('form[data-form="editor"] .line-item').first();
  await last.locator('[data-details="remove"]').click();
  await expect(last.locator('[data-details="add"]')).toBeVisible();
  await page.locator('form[data-form="editor"] button[type=submit]').click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await expect(page.locator(".quote-scope").first()).toContainText("Corporate website");
  await expect(page.locator(".line-details-view")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Items saved in any document are offered again: click the title, pick one,
// and the title, description and rate are filled in.
test("line items: pick an item used before", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Picks");
  await createClient(page, client);
  const title = unique("Website package");
  const token = title.split(" ").pop();

  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  let editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  let row = editor.locator(".line-item").first();
  await row.locator(".item-description").fill(title);
  await row.locator(".item-rate").fill("2650");
  await row.locator('[data-details="add"]').click();
  await page.keyboard.type("Up to ");
  await row.locator('[data-fmt="bold"]').click();
  await page.keyboard.type("7 pages");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");

  // A new invoice: typing part of the title lists it; one click fills the line.
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  row = editor.locator(".line-item").first();
  await row.locator(".item-description").click();
  await expect(row.locator(".line-suggest")).toBeVisible();
  await row.locator(".item-description").fill(token);
  const option = row.locator(".suggest-item", { hasText: title });
  await expect(option).toHaveCount(1);
  await expect(option).toContainText("Up to 7 pages");
  await expect(option).toContainText("2,650.00");
  await option.click();
  row = editor.locator(".line-item").first();
  await expect(row.locator(".item-description")).toHaveValue(title);
  await expect(row.locator(".item-rate")).toHaveValue("2650.00");
  await expect(row.locator(".item-details strong")).toHaveText("7 pages");
  await expect(row.locator(".item-quantity")).toBeFocused();
  await expect(editor.locator(".line-suggest")).toHaveCount(0);

  // The keyboard works too: arrows and Enter pick, Esc closes only the list.
  await editor.locator('[data-action="add-line"]').click();
  const second = editor.locator(".line-item").nth(1);
  await second.locator(".item-description").fill(token);
  await expect(second.locator(".line-suggest")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(second.locator(".line-suggest")).toHaveCount(0);
  await expect(editor).toBeVisible();
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(editor.locator(".line-item").nth(1).locator(".item-rate")).toHaveValue("2650.00");
  await expect(page.locator("#live-preview")).toContainText("5,300.00");

  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  await expect(page.locator(".quote-scope .line-title").first()).toHaveText(title);
  await expect(page.locator(".quote-scope .line-details-view strong").first()).toHaveText("7 pages");
  expect(errors).toEqual([]);
});

// A description over the limit is never cut: the counter says so and saving is refused.
test("line items: a description over 3000 characters is kept and refused, not cut", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Long");
  await createClient(page, client);
  await page.goto("/#/quotes");
  await page.click('[data-action="new-quote"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  const row = editor.locator(".line-item").first();
  await row.locator(".item-description").fill("Long scope");
  await row.locator(".item-rate").fill("100");
  await row.locator('[data-details="add"]').click();
  const box = row.locator(".item-details");
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "x".repeat(3001));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(row.locator(".details-count")).toHaveText("3001 / 3000 · too long to save");
  await expect(row.locator(".details-count")).toHaveClass(/red-text/);
  await editor.locator("button[type=submit]").click();
  await expect(page.getByRole("alert")).toContainText("Line 1: the description can have up to 3000 characters.");
  await expect(editor).toBeVisible();
  expect((await box.textContent()).length).toBe(3001);
  // One character shorter, and it saves.
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(row.locator(".details-count")).toHaveText("3000 / 3000");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
});
