// Team and security: users and roles, accountant access, password reset, MFA QR, off-site backups and a verifiable audit chain.
// Browser module contract: see docs/PLUGINS.md.
export default function teamUI(h) {
  const { E, button, badge, heading, input, select, formEnd, errorBlock, showModal, modal, api, refresh, renderRoute, toast, timeLabel, empty, icon } = h;
  const team = () => h.get()?.ext?.team || {};
  const role = () => team().me?.role || null;
  const isOwner = () => !role() || role() === "owner";
  const roleLabel = (r) => team().roles?.[r]?.label || r;

  // What each role sees. The server enforces the same rules (server/team-roles.mjs);
  // this only hides what would be refused.
  const STAFF_HIDDEN = new Set([
    "void-document",
    "reverse-payment",
    "invoice-adjust",
    "delete-client",
    "delete-service",
    "delete-schedule",
    "cash-refund",
    "cash-void",
    "cash-review",
    "bank-exclude",
    "bank-reset",
    "secret-edit",
    "secret-clear",
    "backup-now",
    "run-reminders",
  ]);
  const READ_ACTIONS = new Set(["close-modal", "toggle-nav", "logout", "filter", "page", "reload", "client-statement", "statement-pdf", "mfa-setup", "copy-link"]);
  const READ_PREFIX = /^(open|view|show|download|toggle|filter|team-(verify|copy|forgot))(-|$)/;
  const OWNER_PAGES = { staff: ["settings", "automation", "team", "audit"], accountant: ["settings", "automation", "team"] };

  async function copyField(name) {
    const el = modal.querySelector(`[name="${name}"]`);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value);
      toast("Copied.");
    } catch {
      el.select();
      toast("Select and copy the text from the field.");
    }
  }
  const done = async (message) => {
    modal.close();
    await refresh();
    renderRoute();
    if (message) toast(message);
  };
  const passwordFields = () =>
    input("Your current password", "password", "", "password", true, 'autocomplete="current-password"') +
    (h.get().security?.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : "");
  const statusBadge = (s) => `<span class="badge ${{ Active: "green", Invited: "blue", Disabled: "red" }[s] || ""}"><span class="dot"></span>${E(s)}</span>`;
  const short = (hash) => (hash ? hash.slice(0, 12) + "…" + hash.slice(-6) : "—");

  // ---- Users ---------------------------------------------------------------
  function linkResult(title, r, intro) {
    showModal(
      title,
      `${intro}${r.link ? `${input("One-time link", "teamlink", r.link, "url", false, "readonly")}<p class="field-hint">Treat this link like a password. Send it only to this person.</p><div class="actions mt22">${button("Copy link", "team-copy", "teamlink", true, "copy")}${button("Done", "close-modal")}</div>` : `<div class="actions mt22">${button("Done", "close-modal", "", true)}</div>`}`,
    );
  }
  function inviteResult(r, verb = "Invitation created") {
    const intro = r.emailed
      ? `<div class="notice info"><p>${E(verb)} and emailed to ${E(r.user.email)}. The link expires in 7 days. You can also copy it below.</p></div>`
      : `<div class="notice"><p>${r.emailError ? E(r.emailError) + " " : "Email is not configured, so nothing was sent. "}Copy this one-time link and send it to ${E(r.user.email)} yourself. It expires in 7 days.</p></div>`;
    linkResult("Invitation ready", r, intro);
  }
  function roleOptions() {
    return Object.entries(team().roles || {}).map(([k, v]) => [k, v.label]);
  }
  function teamPage() {
    const t = team();
    const users = t.users || [];
    const owners = users.filter((u) => u.role === "owner" && u.status === "Active").length;
    return (
      heading("Team", "Who can sign in to this workspace, and what they can do.", button("Invite user", "team-invite", "", true, "plus")) +
      (!t.mail
        ? `<div class="notice">${icon("shield")}<p>Email is not configured. Invitation links are shown for you to copy, and members who forget their password need you to create a reset link for them.</p></div>`
        : "") +
      `<section class="panel"><div class="table-wrap"><table class="team-users"><caption class="sr-only">Users</caption><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Authenticator</th><th>Last sign-in</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${users
        .map((u) => {
          const self = u.id === t.me?.id;
          const lastOwner = u.role === "owner" && u.status === "Active" && owners <= 1;
          const actions =
            u.status === "Invited"
              ? button("Send again", "team-resend", u.id) + button("Edit", "team-edit", u.id) + button("Remove", "team-remove", u.id)
              : (self || lastOwner ? "" : button("Edit", "team-edit", u.id)) +
                (self ? "" : u.disabled ? button("Enable", "team-enable", u.id) : lastOwner ? "" : button("Disable", "team-disable", u.id)) +
                (!self && !u.disabled ? button("Reset password", "team-reset-link", u.id) : "") +
                (!self && u.mfa ? button("Reset MFA", "team-reset-mfa", u.id) : "");
          return `<tr><td><strong>${E(u.name || u.email)}${self ? " (you)" : ""}</strong><small>${E(u.email)}</small></td><td>${E(roleLabel(u.role))}${lastOwner ? "<small>Last owner</small>" : ""}</td><td>${statusBadge(u.status)}${u.status === "Invited" && u.invited ? `<small>Invited ${timeLabel(u.invited)}</small>` : ""}</td><td>${u.mfa ? badge("Enabled") : '<span class="muted">Not set up</span>'}</td><td>${u.last_sign_in ? timeLabel(u.last_sign_in) : '<span class="muted">Never</span>'}</td><td><div class="actions">${actions}</div></td></tr>`;
        })
        .join("")}</tbody></table></div></section><section class="panel mt22"><div class="panel-head"><h2>Roles</h2></div><div class="team-roles">${Object.entries(t.roles || {})
        .map(([k, v]) => `<div class="team-role"><span class="eyebrow teal">${E(v.label)}</span><p>${E(v.summary)}</p><small>${users.filter((u) => u.role === k).length} user(s)</small></div>`)
        .join("")}</div><p class="field-hint">Every change is recorded in the audit trail with the person who made it. The workspace always keeps at least one active owner.</p></section>`
    );
  }
  function inviteForm() {
    showModal(
      "Invite user",
      `<form data-form="team-invite"><div class="form-grid">${input("Email address", "email", "", "email", true, 'maxlength="160" autocomplete="off"')}${input("Name (optional)", "name", "", "text", false, 'maxlength="120"')}<div class="span-2">${select("Role", "role", roleOptions(), "staff")}</div></div><div class="team-role-help">${Object.values(team().roles || {})
        .map((v) => `<p><strong>${E(v.label)}:</strong> ${E(v.summary)}</p>`)
        .join("")}</div>${formEnd(team().mail ? "Send invitation" : "Create invitation link")}</form>`,
    );
  }
  function editForm(id) {
    const u = (team().users || []).find((x) => String(x.id) === String(id));
    if (!u) return;
    showModal(
      "Edit " + (u.name || u.email),
      `<form data-form="team-edit" data-id="${E(id)}"><p>${E(u.email)}</p>${input("Name", "name", u.name, "text", false, 'maxlength="120"')}${select("Role", "role", roleOptions(), u.role)}<p class="field-hint">A new role applies to their next request; they do not need to sign in again.</p>${formEnd("Save")}</form>`,
    );
  }

  // ---- Audit chain ---------------------------------------------------------
  function verifyResult(r) {
    if (r.ok)
      return `<div class="notice info team-result">${icon("check")}<p><strong>Audit chain OK.</strong> ${r.checked} entries verified ${timeLabel(r.verified)}.${r.recorded ? ` The recorded head (entry ${E(r.recorded.id)}) still matches.` : ""}${r.unsealed ? ` ${r.unsealed} newest entries are waiting to be sealed.` : ""}<br>Head: entry ${E(r.head.id)} · <span class="team-hash">${E(r.head.hash)}</span></p></div>`;
    return `<div class="notice team-result team-broken">${icon("shield")}<p><strong>Audit chain broken.</strong> ${E(r.reason)}${r.broken ? `<br>First bad entry: ${E(r.broken.id)} (${E(r.broken.action)}, ${timeLabel(r.broken.created)}). ${r.checked} entries before it verified.` : ""}</p></div>`;
  }
  function auditPage() {
    const S = h.get();
    const head = team().audit || {};
    return (
      heading(
        "Audit trail",
        "Every change is recorded, cannot be edited or deleted in the app, and is chained so later tampering can be detected.",
        button("Verify audit chain", "team-verify", "", true, "shield"),
      ) +
      `<div id="team-verify-result"></div><div class="grid-equal mt22"><section class="panel"><div class="panel-head"><div><h2>Chain head</h2><p>Record this from time to time (for example at month end). It is your proof of what the history looked like.</p></div></div><dl class="detail"><dt>Latest entry</dt><dd>${E(head.id ?? "—")}</dd><dt>Hash</dt><dd class="team-hash">${E(head.hash || "—")}</dd><dt>Written</dt><dd>${head.created ? timeLabel(head.created) : "—"}</dd><dt>Entries</dt><dd>${E(head.entries ?? 0)}</dd></dl><div class="actions mt22"><a class="btn" href="/api/team/audit/head?download=1">${icon("download")} Download chain head</a></div></section><section class="panel"><div class="panel-head"><div><h2>Check a recorded head</h2><p>Confirms that history up to that entry is unchanged.</p></div></div><form data-form="team-check-head"><div class="form-grid">${input("Entry number", "id", "", "number", true, 'min="1" step="1"')}<div class="span-2">${input("Hash (64 characters)", "hash", "", "text", true, 'pattern="[0-9a-fA-F]{64}" maxlength="64" autocomplete="off"')}</div></div>${errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Check</button></div></form><div id="team-head-result"></div></section></div><section class="panel mt22"><div class="panel-head"><h2>What this proves</h2></div><p>Each entry's hash covers its content and the hash of the entry before it. If anyone later changes, removes or reorders an entry, verification shows the first entry that no longer fits, <strong>provided you can compare against a chain head recorded earlier</strong>. Someone with full access to the server could rewrite the whole history and recompute every hash, so the chain alone only proves internal consistency. A head kept outside the server (your accountant's files, an email, a printout) is what makes rewriting detectable.</p><p class="field-hint">It does not prove that an entry was true when written, and it cannot show changes made before the chain began; existing history was sealed when this feature was installed.</p></section><section class="panel mt22"><div class="panel-head"><h2>Recent entries</h2><p class="muted">Latest ${S.audit.length}</p></div><div class="table-wrap"><table class="team-audit"><thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Hash</th></tr></thead><tbody>${S.audit
        .map(
          (a) =>
            `<tr><td>${E(a.id)}</td><td>${timeLabel(a.created)}</td><td>${E(a.actor || "system")}</td><td class="team-what"><strong>${E(a.action)}</strong>${a.detail ? `<small>${E(a.detail)}</small>` : ""}</td><td class="team-hash" title="${E(a.hash || "")}">${E(short(a.hash))}</td></tr>`,
        )
        .join("")}</tbody></table></div></section>`
    );
  }

  // ---- My account (staff and accountants) -----------------------------------
  function accountPage() {
    const S = h.get(),
      me = team().me || {};
    return (
      heading("My account", "Your sign-in details, password and authenticator.") +
      `<div class="grid-equal"><section class="panel"><div class="panel-head"><h2>${E(me.name || me.email)}</h2>${badge(roleLabel(me.role))}</div><dl class="detail"><dt>Email</dt><dd>${E(me.email)}</dd><dt>Access</dt><dd>${E(team().roles?.[me.role]?.summary || "")}</dd></dl><p class="field-hint">Your actions are recorded in the audit trail under your email. Ask the workspace owner to change your role.</p></section><section class="panel"><div class="panel-head"><h2>Authenticator & recovery</h2>${badge(S.security.enabled ? "Enabled" : "Not enabled")}</div><p>${S.security.enabled ? `${S.security.recoveryRemaining} unused recovery codes.` : "Add an authenticator app for a second sign-in step."}</p><div class="actions mt22">${button(S.security.enabled ? "Manage MFA" : "Enable MFA", "mfa-setup")}</div><p class="field-hint">Lost your authenticator and recovery codes? Ask the workspace owner to reset it.</p></section></div><section class="panel mt22"><div class="panel-head"><h2>Change password</h2></div><form data-form="team-password">${input("Current password", "current", "", "password", true, 'autocomplete="current-password"')}${input("New password (at least 12 characters)", "password", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${errorBlock()}<button type="submit" class="btn">Change password & sign out</button></form></section>`
    );
  }

  // ---- Settings panels (owner) ---------------------------------------------
  function teamSettings() {
    const t = team();
    const users = t.users || [];
    const count = (r) => users.filter((u) => u.role === r && u.status !== "Disabled").length;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Team & access</h2><p>${count("owner")} owner(s), ${count("staff")} staff, ${count("accountant")} accountant(s)${users.some((u) => u.status === "Invited") ? " · invitations pending" : ""}</p></div><a href="#/team">Manage team →</a></div><div class="setting-line"><div><h3>Password reset by email</h3><p>${t.mail ? "“Forgot password?” on the sign-in page sends a one-time link (30 minutes)." : "Off until email is configured. Console recovery (npm run recover) still works."}</p></div>${badge(t.mail ? "Active" : "Not connected")}</div><div class="setting-line"><div><h3>Audit chain</h3><p>Entry ${E(t.audit?.id ?? 0)} · ${E(short(t.audit?.hash))}</p></div><a href="#/audit">Verify →</a></div></section>`;
  }
  function backupSettings() {
    const b = team().backup;
    if (!b) return "";
    const st = b.status || {},
      rm = b.remote || {};
    const local = st.configured
      ? `<p>${st.lastSuccess ? "Last backup: " + timeLabel(st.lastSuccess) : "No backup yet since the server started."}</p>${st.lastError ? `<p class="red-text">${E(st.lastError)}</p>` : ""}<div class="setting-line"><div><h3>Backup key</h3><p>${b.keySource === "app" ? "Generated in Settings and stored encrypted on this server. Keep your saved copy safe." : "Set on the server (BACKUP_KEY)."}</p></div>${badge("Configured")}</div><div class="setting-line"><div><h3>Backup folder</h3><p>${E(b.directory || "")}${b.directorySource === "default" ? " (default, inside the data folder)" : ""}</p></div></div><p class="field-hint">A backup runs when the server starts and every 24 hours. The newest 7 files are kept in the folder.</p>`
      : `<p>${b.keySource ? "A backup key is set, but no backup folder is available. Set BACKUP_DIRECTORY on the server." : "No backup key yet. Generate one here, or set BACKUP_KEY (and optionally BACKUP_DIRECTORY) on the server."}</p>`;
    const last = rm.lastAttempt;
    const remote = rm.configured
      ? `<div class="setting-line"><div><h3>${E(rm.provider)}</h3><p>Bucket ${E(rm.bucket)} · region ${E(rm.region)} · folder ${E(rm.prefix || "(root)")} · keeps ${E(rm.keep)} copies</p></div>${badge(last?.status === "failed" ? "Failed" : "Connected")}</div><div class="setting-line"><div><h3>Last upload</h3><p>${rm.lastUpload ? `${timeLabel(rm.lastUpload.created)} · ${E(rm.lastUpload.filename)} · ${(rm.lastUpload.bytes / 1048576).toFixed(2)} MB` : "Nothing uploaded yet."}${last?.status === "failed" ? `<br><span class="red-text">Last attempt ${timeLabel(last.created)} failed: ${E(last.error)}</span>` : ""}</p></div></div>${rm.lastTest ? `<p class="field-hint">Connection test ${timeLabel(rm.lastTest.at)}: ${rm.lastTest.ok ? "upload, download, list and delete all worked." : `failed at ${E(rm.lastTest.step)}: ${E(rm.lastTest.error)}`}</p>` : ""}`
      : `<p>${rm.configError ? `<span class="red-text">${E(rm.configError)}</span>` : "Not set up. Add the endpoint, region, bucket and access keys under Integration keys (“Off-site backup: …”). Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi and DigitalOcean Spaces."}</p>`;
    return `<section class="panel mt22" id="team-backups"><div class="panel-head"><div><h2>Encrypted backups</h2><p>Local copies on this server, and an off-site copy after each backup.</p></div>${badge(st.configured ? "Configured" : "Not configured")}</div>${local}<div class="actions mt22">${st.configured ? button("Run backup now", "team-backup-now", "", true) : b.keySource ? "" : button("Generate backup key", "team-backup-key", "", true, "shield")}</div><h3 class="mt22">Off-site copy</h3>${remote}<div class="actions mt22">${rm.configured ? button("Test connection", "team-backup-test") + button("Show off-site copies", "team-backup-list") + (last?.status === "failed" && st.configured ? button("Upload latest again", "team-backup-upload") : "") : ""}</div><div class="notice mt22">${icon("shield")}<p>Backups are encrypted with your backup key before they leave this server. <strong>Without the backup key, no one (including you) can restore a copy.</strong> Keep the key in your password manager, separate from the server.</p></div></section>`;
  }
  function backupKeyForm() {
    showModal(
      "Generate backup key",
      `<form data-form="team-backup-key"><p>A new 256-bit key will encrypt every backup. It is shown <strong>once</strong>. Save it in your password manager before you close the next screen.</p><p class="field-hint">Backups go to ${E(team().backup?.directory || "a backups folder next to the database")}.</p>${passwordFields()}${formEnd("Generate key")}</form>`,
    );
  }

  // ---- Password reset and invitations (no sign-in) ---------------------------
  function guestShell(title, sub, body) {
    return `<div class="login-screen"><section class="login-brand"><span class="eyebrow">NAWLOGIC / BILLING WORKSPACE</span><h1>${E(title)}</h1><p>${E(sub)}</p></section><section class="login-form"><div class="login-inner"><img class="logo" src="/assets/nawlogic-logo.png" alt="Nawlogic">${body}</div></section></div>`;
  }
  async function guestPage(location) {
    const m = location.pathname.match(/^\/(invite|reset)\/([\w-]{1,100})$/);
    if (!m) return false;
    const [, kind, token] = m;
    const app = document.querySelector("#app");
    let info;
    try {
      info = await api(`/guest/team/${kind}/${token}`);
    } catch (e) {
      app.innerHTML = guestShell(
        kind === "invite" ? "Invitation unavailable." : "Reset link unavailable.",
        "Links work once and expire.",
        `<h2>This link cannot be used.</h2><p>${E(e.message)} ${kind === "invite" ? "Ask the workspace owner to send a new invitation." : "Ask for a new link from the sign-in page."}</p><a class="btn primary" href="/">Go to sign in</a>`,
      );
      return true;
    }
    document.title = (kind === "invite" ? "Join " : "Reset password | ") + info.company;
    app.innerHTML =
      kind === "invite"
        ? guestShell(
            `Join ${info.company}.`,
            `You were invited as ${info.role_label}. Choose a password to finish setting up your account.`,
            `<h2>Set up your account</h2><p>${E(info.email)} · ${E(info.role_label)}</p><form data-form="team-guest" data-kind="invite" data-id="${E(token)}">${input("Your name", "name", info.name || "", "text", false, 'maxlength="120" autocomplete="name"')}${input("New password (at least 12 characters)", "password", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${input("Repeat password", "confirm", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${errorBlock()}<button class="btn primary" type="submit">Create account ${icon("arrow")}</button></form>`,
          )
        : guestShell(
            "Choose a new password.",
            "The link works once and expires 30 minutes after it was sent.",
            `<h2>Reset password</h2><p>${E(info.email)}</p><form data-form="team-guest" data-kind="reset" data-id="${E(token)}">${input("New password (at least 12 characters)", "password", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${input("Repeat password", "confirm", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}<p class="field-hint">You will be signed out everywhere.${info.mfa ? " Your authenticator code is still needed when you sign in." : ""}</p>${errorBlock()}<button class="btn primary" type="submit">Save new password ${icon("arrow")}</button></form>`,
          );
    return true;
  }
  async function forgot() {
    let reset = false;
    try {
      reset = (await api("/guest/team/options")).reset;
    } catch {}
    if (!reset)
      return showModal(
        "Forgot password?",
        `<p>Password reset by email is not set up for this workspace.</p><ul class="team-list"><li>Team members: ask the workspace owner for a reset link.</li><li>Owner: the server operator can run <code>npm run recover</code> on the server. It sets a new one-time password, turns off MFA and signs out every session.</li></ul><div class="form-actions">${button("Close", "close-modal", "", true)}</div>`,
      );
    showModal(
      "Forgot password?",
      `<form data-form="team-forgot"><p>Enter your sign-in email. If it belongs to an account, we will send a link to choose a new password. The link works once and expires in 30 minutes.</p>${input("Email address", "email", document.querySelector('form[data-form="login"] [name=email]')?.value || "", "email", true, 'maxlength="160" autocomplete="username"')}${formEnd("Send reset link")}</form>`,
    );
  }

  return {
    nav: [
      { key: "team", label: "Team", icon: "users", group: "Workspace", hidden: () => !isOwner() },
      { key: "audit", label: "Audit", icon: "shield", group: "Workspace", hidden: () => !["owner", "accountant"].includes(role()) },
      { key: "account", label: "My account", icon: "settings", group: "Workspace", hidden: () => isOwner() },
    ],
    pages: {
      team: () => (isOwner() ? teamPage() : empty("Not available", "Only the workspace owner manages the team.")),
      audit: () => auditPage(),
      account: () => accountPage(),
    },
    can(kind, name) {
      const r = role();
      if (!r || r === "owner") return true;
      if (kind === "nav" || kind === "page") return !OWNER_PAGES[r]?.includes(name);
      if (kind === "action") return r === "staff" ? !STAFF_HIDDEN.has(name) : READ_ACTIONS.has(name) || READ_PREFIX.test(name);
      return true;
    },
    guestPage,
    slots: {
      login: () =>
        `<p class="team-forgot"><button type="button" class="link-button" data-action="team-forgot">Forgot password?</button></p>`,
      topbar: () => (isOwner() ? "" : `<span class="badge blue">${E(roleLabel(role()))}${role() === "accountant" ? " · read-only" : ""}</span>`),
      settings: () => (isOwner() ? teamSettings() + backupSettings() : ""),
    },
    async action(type, id) {
      switch (type) {
        case "team-forgot":
          await forgot();
          return true;
        case "team-copy":
          await copyField(id);
          return true;
        case "team-invite":
          inviteForm();
          return true;
        case "team-edit":
          editForm(id);
          return true;
        case "team-resend":
          inviteResult(await api(`/team/users/${id}/invite`, "POST", {}), "New invitation created");
          await refresh();
          return true;
        case "team-remove":
        case "team-disable":
        case "team-enable": {
          const u = (team().users || []).find((x) => String(x.id) === String(id));
          const text = {
            "team-remove": ["Remove invitation?", "The invitation link stops working and the pending user is removed.", "Remove"],
            "team-disable": ["Disable user?", `${u?.email} is signed out everywhere and cannot sign in until you enable the account again. Their history stays in the audit trail.`, "Disable"],
            "team-enable": ["Enable user?", `${u?.email} can sign in again with their existing password.`, "Enable"],
          }[type];
          h.confirmModal(text[0], text[1], "team-confirm-" + type.slice(5), id, text[2]);
          return true;
        }
        case "team-confirm-remove":
        case "team-confirm-disable":
        case "team-confirm-enable": {
          const what = type.slice("team-confirm-".length);
          try {
            if (what === "remove") await api(`/team/users/${id}`, "DELETE");
            else await api(`/team/users/${id}/${what}`, "POST", {});
          } catch (e) {
            modal.querySelector(".form-error").textContent = e.message;
            return true;
          }
          await done({ remove: "Invitation removed.", disable: "User disabled and signed out.", enable: "User enabled." }[what]);
          return true;
        }
        case "team-reset-mfa": {
          const u = (team().users || []).find((x) => String(x.id) === String(id));
          showModal(
            "Reset authenticator",
            `<form data-form="team-reset-mfa" data-id="${E(id)}"><p>${E(u?.email)} loses their authenticator and recovery codes and is signed out. They sign in with their password and can set up MFA again.</p>${passwordFields()}${formEnd("Reset MFA")}</form>`,
          );
          return true;
        }
        case "team-reset-link": {
          const r = await api(`/team/users/${id}/reset-link`, "POST", {});
          if (r.emailed) toast(`Reset link emailed to ${r.email}. It expires in 30 minutes.`);
          else
            linkResult(
              "Password reset link",
              r,
              `<div class="notice"><p>Email is not configured. Send this link to ${E(r.email)} yourself. It works once and expires in 30 minutes. Creating it is recorded in the audit trail.</p></div>`,
            );
          return true;
        }
        case "team-verify": {
          const out = document.querySelector("#team-verify-result");
          const r = await api("/team/audit/verify");
          if (out) out.innerHTML = verifyResult(r);
          toast(r.ok ? "Audit chain verified." : "Audit chain is broken. See the details.", !r.ok);
          return true;
        }
        case "team-backup-key":
          backupKeyForm();
          return true;
        case "team-backup-now": {
          const r = await api("/recovery/backup", "POST", {});
          await refresh();
          renderRoute();
          toast(
            r.remote?.status === "uploaded"
              ? "Encrypted backup created and copied off-site."
              : r.remote?.status === "failed"
                ? "Backup created on this server, but the off-site upload failed: " + r.remote.error
                : "Encrypted backup created.",
            r.remote?.status === "failed",
          );
          return true;
        }
        case "team-backup-test": {
          const r = await api("/team/backup/test", "POST", {});
          await refresh();
          renderRoute();
          toast(r.ok ? `Off-site storage works (${r.ms} ms).` : `Test failed at ${r.step}: ${r.error}`, !r.ok);
          return true;
        }
        case "team-backup-upload": {
          const r = await api("/team/backup/upload", "POST", {});
          await refresh();
          renderRoute();
          toast(`Uploaded ${r.filename}.`);
          return true;
        }
        case "team-backup-list": {
          const list = await api("/team/backup/remote");
          showModal(
            "Off-site copies",
            list.length
              ? `<div class="table-wrap"><table><thead><tr><th>File</th><th class="num">Size</th><th>Uploaded</th></tr></thead><tbody>${list.map((o) => `<tr><td class="team-hash">${E(o.filename)}</td><td class="num">${(o.size / 1048576).toFixed(2)} MB</td><td>${o.modified ? timeLabel(o.modified) : "—"}</td></tr>`).join("")}</tbody></table></div><p class="field-hint">To restore: download a copy with <code>node server/cli.mjs fetch-backup &lt;file&gt; &lt;output&gt;</code>, then <code>npm run restore</code> with the original backup key.</p>`
              : "<p>No off-site copies yet.</p>",
            true,
          );
          return true;
        }
        case "client-statement":
          // Accountants download statements; emailing them is a staff task.
          if (role() !== "accountant") return false;
          showModal(
            "Statement of account",
            `<form data-form="statement" data-id="${E(id)}"><div class="form-grid">${input("From", "from_date", h.addDays(h.get().today, -90), "date", true)}${input("To", "to_date", h.get().today, "date", true)}</div><div class="actions mt22">${button("Download PDF", "statement-pdf", id, true)}</div></form>`,
          );
          return true;
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form,
        id = form.dataset.id;
      if (type === "mfa-begin") {
        // Same flow as the core, with a QR code to scan next to the setup key.
        const setup = await api("/mfa/begin", "POST", b);
        modal.close();
        const qr = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(setup.qr || "") ? setup.qr : "";
        showModal(
          "Verify authenticator",
          `<form data-form="mfa-enable"><div class="team-mfa">${qr ? `<img class="team-qr" src="${E(qr)}" alt="QR code for your authenticator app">` : ""}<div><p>Scan the QR code with your authenticator app, or add a time-based account with the setup key. Keep both private.</p>${input("Setup key", "secret", setup.secret, "text", false, 'readonly autocomplete="off"')}</div></div>${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${input("6-digit authenticator code", "code", "", "text", true, 'inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"')}${formEnd("Enable MFA")}</form>`,
        );
        return true;
      }
      if (type === "team-forgot") {
        const r = await api("/guest/team/reset", "POST", { email: b.email });
        showModal(
          "Check your email",
          `<p>If an account exists for ${E(b.email)}, a reset link is on its way. It works once and expires in 30 minutes.</p>${r.email ? "" : "<p>Email is not configured on this server.</p>"}<p class="field-hint">Nothing arrived? Check spam, or ask the workspace owner.</p><div class="form-actions">${button("Close", "close-modal", "", true)}</div>`,
        );
        return true;
      }
      if (type === "team-guest") {
        if (b.password !== b.confirm) throw new Error("The passwords do not match.");
        const kind = form.dataset.kind;
        const r = await api(`/guest/team/${kind}/${id}`, "POST", kind === "invite" ? { password: b.password, name: b.name } : { password: b.password });
        history.replaceState(null, "", "/");
        document.querySelector(".login-inner").innerHTML =
          `<img class="logo" src="/assets/nawlogic-logo.png" alt="Nawlogic"><h2>${kind === "invite" ? "Your account is ready." : "Password changed."}</h2><p>${kind === "invite" ? `Sign in as ${E(r.email)} with your new password.` : `You were signed out everywhere. Sign in as ${E(r.email)} with the new password${r.mfa ? " and your authenticator code" : ""}.`}</p><a class="btn primary" href="/">Go to sign in ${icon("arrow")}</a>`;
        return true;
      }
      if (type === "team-invite") {
        const r = await api("/team/users", "POST", { email: b.email, name: b.name, role: b.role });
        await refresh();
        renderRoute();
        inviteResult(r);
        return true;
      }
      if (type === "team-edit") {
        await api(`/team/users/${id}`, "PUT", { name: b.name, role: b.role });
        await done("User updated.");
        return true;
      }
      if (type === "team-reset-mfa") {
        await api(`/team/users/${id}/reset-mfa`, "POST", { password: b.password, code: b.code });
        await done("Authenticator reset. The user was signed out.");
        return true;
      }
      if (type === "team-password") {
        await api("/team/password", "POST", b);
        location.reload();
        return true;
      }
      if (type === "team-check-head") {
        const r = await api(`/team/audit/verify?${new URLSearchParams({ id: b.id, hash: b.hash.trim() })}`);
        const out = document.querySelector("#team-head-result");
        if (out) out.innerHTML = verifyResult(r);
        return true;
      }
      if (type === "team-backup-key") {
        const r = await api("/team/backup/key", "POST", { password: b.password, code: b.code });
        modal.close();
        showModal(
          "Save your backup key",
          `<div class="notice"><p><strong>This is the only time the key is shown.</strong> Save it in your password manager now. Without it, no backup (local or off-site) can be restored.</p></div>${input("Backup key", "teamkey", r.key, "text", false, 'readonly autocomplete="off"')}<div class="actions mt22">${button("Copy key", "team-copy", "teamkey", true, "copy")}</div><form data-form="team-key-saved"><label class="check-row mt22"><input type="checkbox" name="saved" required> I saved the backup key somewhere safe, away from this server.</label><div class="form-actions"><button class="btn primary" type="submit">Done</button></div></form>`,
        );
        return true;
      }
      if (type === "team-key-saved") {
        await done(team().backup ? "Backup key saved. Run a backup to test it." : "");
        return true;
      }
      return false;
    },
  };
}
