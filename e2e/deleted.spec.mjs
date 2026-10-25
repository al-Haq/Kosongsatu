import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique, createClient } from "./helpers.mjs";

test("a deleted draft comes back with Undo and from Recently deleted", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const client = unique("E2E Deleted Client");
  await createClient(page, client);
  await page.goto("/#/invoices");
  await page.click('[data-action="new-invoice"]');
  const editor = page.locator('form[data-form="editor"]');
  await editor.locator("select[name=client_id]").selectOption({ label: client });
  await editor.locator(".item-description").first().fill("Router setup");
  await editor.locator(".item-rate").first().fill("300");
  await editor.locator("button[type=submit]").click();
  await expect(page.locator("#toast")).toContainText("Draft saved");
  const url = page.url();

  // Delete (under More), then Undo from the message: the same draft opens again.
  await page.click(".heading .dropdown summary");
  await page.click('[data-action="delete-draft"]');
  await expect(page.locator("dialog")).toContainText("Recently deleted");
  await page.click('[data-action="confirm-delete-draft"]');
  await expect(page.locator("#toast")).toContainText("Draft deleted.");
  await page.locator("#toast .toast-undo").click();
  await expect(page.locator("#toast")).toContainText("Invoice draft restored.");
  await expect(page).toHaveURL(url);
  await expect(page.locator(".invoice-paper")).toContainText("Router setup");

  // Delete again and restore from the Recently deleted page.
  await page.click(".heading .dropdown summary");
  await page.click('[data-action="delete-draft"]');
  await page.click('[data-action="confirm-delete-draft"]');
  await expect(page.locator("#toast")).toContainText("Draft deleted.");
  await page.locator('.sidebar nav a[href="#/deleted"]').click();
  const row = page.locator(".bin-table tr", { hasText: client });
  await expect(row).toContainText("Invoice draft");
  await row.locator('[data-action="bin-restore"]').click();
  await expect(page.locator("#toast")).toContainText("Invoice draft restored.");
  await expect(page.locator(".bin-table tr", { hasText: client })).toHaveCount(0);
  await page.goto(url);
  await expect(page.locator(".invoice-paper")).toContainText("Router setup");
  expect(errors).toEqual([]);
});
