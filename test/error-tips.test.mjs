// When something fails, the screen says why it usually happens and what to try.
import test from "node:test";
import assert from "node:assert/strict";
import { errorTip, errorHtml } from "../public/ext/error-tips.mjs";

test("common failures get a reason and a fix", () => {
  const cases = [
    [
      "Session verification failed. Refresh and try again.",
      403,
      /out of date.*reload the page/is,
    ],
    [
      "You are now signed in as other@example.com in another tab.",
      409,
      /Reload the page/,
    ],
    ["Please sign in.", 401, /sign-in has ended.*Sign in again/s],
    ["Please sign in to the client portal.", 401, /new sign-in link/],
    ["Email or password is incorrect.", 400, /Caps Lock.*reset link/s],
    ["Current password is incorrect.", 403, /present password/],
    [
      "Authenticator or recovery code is required/invalid.",
      403,
      /every 30 seconds.*recovery codes/s,
    ],
    ["Too many attempts. Try again later.", 429, /15 minutes/],
    [
      "Your staff access does not include this. Ask the workspace owner.",
      403,
      /role does not allow/,
    ],
    ["Only the workspace owner can do this.", 403, /role does not allow/],
    [
      "This account is disabled. Ask the workspace owner.",
      403,
      /turn your account back on/,
    ],
    ["Request origin is not allowed.", 403, /usual web address/],
    ["Server returned an unreadable response.", 502, /restarting/],
    ["This link is invalid or has expired.", 400, /new link/],
    ["Link expired or unavailable.", 404, /new link/],
    [
      "Issued documents are locked. Void and replace if appropriate.",
      400,
      /Duplicate it/,
    ],
    [
      "An accepted quotation can't be edited. Duplicate it to make a new version.",
      400,
      /client accepted/,
    ],
    ["Upload is too large.", 413, /smaller file/],
    [
      "Unexpected server error. Please try again.",
      500,
      /docker compose logs app/,
    ],
  ];
  for (const [message, status, expected] of cases)
    assert.match(errorTip(message, status), expected, message);
});

test("other failures fall back on the HTTP status; plain field checks need no tip", () => {
  assert.match(errorTip("Client not found.", 404), /deleted/);
  assert.match(
    errorTip("Something else changed.", 409),
    /Reload to see the latest/,
  );
  assert.match(errorTip("Gateway timeout", 504), /server log/);
  assert.equal(errorTip("Choose a supported currency.", 400), "");
  assert.equal(errorTip("Choose a supported currency."), "");
  assert.equal(errorTip(""), "");
});

test("errorHtml shows the message, then the tip, escaped", () => {
  const e = Object.assign(
    new Error("Session verification failed. Refresh and try again."),
    { status: 403 },
  );
  const html = errorHtml(e);
  assert.match(
    html,
    /^<strong>Session verification failed\. Refresh and try again\.<\/strong><span class="error-tip">Why: /,
  );
  assert.equal(
    errorHtml(new Error("Bad <b>name</b>")),
    "Bad &lt;b&gt;name&lt;/b&gt;",
  );
  assert.equal(
    errorHtml(Object.assign(new Error("x"), { tip: "Use <this>" })),
    '<strong>x</strong><span class="error-tip">Use &lt;this&gt;</span>',
  );
  assert.equal(
    errorHtml("Choose a supported currency."),
    "Choose a supported currency.",
  );
});
