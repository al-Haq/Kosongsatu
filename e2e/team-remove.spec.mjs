import { test, expect } from "@playwright/test";
import { signIn, watchErrors, unique } from "./helpers.mjs";

// A person who has left is removed for good from Team, after a clear warning.
test("team: Remove permanently deletes a member after confirmation", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  await signIn(page);
  const email = `${unique("leaver").replace(/\s+/g, "-").toLowerCase()}@example.com`;
  await page.goto("/#/team");
  await page.click('[data-action="team-invite"]');
  const invite = page.locator('form[data-form="team-invite"]');
  await invite.locator("input[name=email]").fill(email);
  await invite.locator("select[name=role]").selectOption("staff");
  await invite.locator("button[type=submit]").click();
  const link = await page.locator("input[name=teamlink]").inputValue();
  await page.keyboard.press("Escape");

  // They join, so the row is an active user, not a pending invitation.
  const other = await context.browser().newContext();
  const staff = await other.newPage();
  await staff.goto(link);
  const join = staff.locator('form[data-form="team-guest"]');
  await join.locator("input[name=password]").fill("E2E-leaver-password-28");
  await join.locator("input[name=confirm]").fill("E2E-leaver-password-28");
  await join.locator("button[type=submit]").click();
  await expect(staff.locator(".login-inner")).toContainText(
    "Your account is ready",
  );
  await other.close();

  await page.reload();
  const row = page.locator(".team-users tr", { hasText: email });
  await expect(row).toContainText("Active");
  // The owner's own row has no Remove button.
  await expect(
    page
      .locator(".team-users tr", { hasText: "(you)" })
      .locator('[data-action="team-remove"]'),
  ).toHaveCount(0);
  await row.locator('[data-action="team-remove"]').click();
  const dialog = page.locator("dialog");
  await expect(dialog).toContainText("Remove user permanently?");
  await expect(dialog).toContainText("This cannot be undone");
  await dialog.locator('[data-action="team-confirm-remove"]').click();
  await expect(page.locator("#toast")).toContainText("User removed.");
  await expect(page.locator(".team-users tr", { hasText: email })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
