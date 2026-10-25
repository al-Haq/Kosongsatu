// When something fails, say why it usually happens and what to try next.
// errorTip(message, status) returns one short tip, or "" when the message
// already says enough. The message itself is never changed, so code that
// matches on it keeps working.
const RULES = [
  [
    /^Session verification failed/i,
    "Why: this page's sign-in check is out of date. This happens after signing in or out in another tab, after a server update, or when the page has been open for a long time. Fix: reload the page (what you typed in forms is kept on this device). If it keeps happening, sign out, sign in again and use one tab per account.",
  ],
  [
    /^You are now signed in as /i,
    "Reload the page to work as that account, or sign out there and sign in again with the account you want.",
  ],
  [
    /^Please sign in to the client portal/i,
    "Your portal sign-in has ended. Request a new sign-in link, or open the latest link the business sent you.",
  ],
  [
    /^Please sign in/i,
    "Your sign-in has ended: you signed out in another tab, your password was changed, the owner disabled your account, or the session expired. Sign in again. What you typed in forms is kept on this device.",
  ],
  [
    /^Email or password is incorrect/i,
    "Check for typing mistakes and Caps Lock, and that this is the email your account uses (look-alike characters such as l, I and 1, or O and 0, are common). Forgot your password? The workspace owner can send you a reset link from Team.",
  ],
  [
    /^Current password is incorrect/i,
    "Type your present password, the one you signed in with today. Check Caps Lock. Forgot it? Sign out and ask the workspace owner for a reset link.",
  ],
  [
    /Authenticator or recovery code/i,
    "Enter the 6-digit code shown now in your authenticator app; it changes every 30 seconds. Check that your phone sets its time automatically. You can also use one of your recovery codes (each works once).",
  ],
  [
    /^Too many attempts/i,
    "For safety, this is paused after many tries in a short time. Wait about 15 minutes, then try once more carefully.",
  ],
  [
    /access does not include this|^Only the (workspace )?owner/i,
    "Your role does not allow this. Ask the workspace owner to do it for you, or to change your role in Team.",
  ],
  [
    /account is disabled/i,
    "The workspace owner can turn your account back on in Team.",
  ],
  [
    /^Request origin is not allowed/i,
    "Open the workspace at its usual web address (the one in your invitation email), not by IP address or another domain, then try again.",
  ],
  [
    /unreadable response/i,
    "The server may be restarting, for example during an update. Wait a minute, then reload the page and try again.",
  ],
  [
    /(link|token) (is )?(invalid|expired|used)|invalid, used or expired|invalid, revoked or expired|Link expired or unavailable/i,
    "Links stop working after a while, or after they are used or replaced by a newer one. Ask whoever sent it for a new link.",
  ],
  [
    /^Issued documents are locked|^Only drafts can be deleted/i,
    "Issued documents stay as sent, to keep your records reliable. Duplicate it to start a new draft, or void it and issue a replacement.",
  ],
  [
    /^An accepted quotation can't be edited/i,
    "The client accepted this version. Duplicate it, change the copy and send that as the new quotation.",
  ],
  [
    /^Enter a valid email/i,
    "Use the form name@example.com, with no spaces before or after.",
  ],
  [
    /^(Request|Upload) is too large|^Request too large/i,
    "Use a smaller file (for example, compress the PDF or photo) or shorten the text, then try again.",
  ],
  [
    /^Unexpected server error/i,
    "Something went wrong on the server, not with what you entered. Try again in a minute. If it keeps happening, the administrator can check the server log (docker compose logs app).",
  ],
];

const BY_STATUS = [
  [
    (s) => s === 413,
    "The file or form is too large. Use a smaller file (for example, compress the PDF or photo) and try again.",
  ],
  [
    (s) => s === 404,
    "It may have been deleted, or the page or link is out of date. Reload the page and try again.",
  ],
  [
    (s) => s === 409,
    "This changed in the meantime, maybe in another tab or by a teammate. Reload to see the latest version, then make your change again.",
  ],
  [
    (s) => s === 429,
    "Too many tries in a short time. Wait a few minutes, then try again.",
  ],
  [
    (s) => s === 403,
    "Your access does not allow this. Ask the workspace owner.",
  ],
  [
    (s) => s >= 500,
    "Something went wrong on the server, not with what you entered. Try again in a minute. If it keeps happening, the administrator can check the server log (docker compose logs app).",
  ],
];

export function errorTip(message, status = 0) {
  const text = String(message || "");
  for (const [pattern, tip] of RULES) if (pattern.test(text)) return tip;
  for (const [test, tip] of BY_STATUS)
    if (test(Number(status) || 0)) return tip;
  return "";
}

const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// An error for a .form-error block: the message, then the tip when there is one.
export function errorHtml(error) {
  const message = error?.message ?? String(error ?? "");
  const tip = error?.tip ?? errorTip(message, error?.status);
  return tip
    ? `<strong>${escape(message)}</strong><span class="error-tip">${escape(tip)}</span>`
    : escape(message);
}
