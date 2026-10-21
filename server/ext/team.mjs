// Team and security: users and roles, accountant access, password reset, MFA QR, off-site backups and a verifiable audit chain.
// Feature module contract: see docs/PLUGINS.md.
import { randomBytes } from "node:crypto";
import { requestContext } from "../context.mjs";
import { AppError, check, hash, now } from "../domain.mjs";
import { passwordHash, verifyPassword, cookie } from "../auth.mjs";
import { verifySecondFactor } from "../mfa.mjs";
import { ROLE_INFO, accessRules, allowed } from "../team-roles.mjs";
import { USER_MIGRATION, attachUsers, normalEmail } from "../team-users.mjs";
import { migrateAuditChain, sealAudit, chainHead, verifyAuditChain } from "../team-audit.mjs";
import { BACKUP_MIGRATION, RemoteBackups, attachBackups, configureBackups, latestLocalBackup } from "../team-backup.mjs";

// Longest a storage request may take (uploads allow 10 minutes), plus margin.
const REMOTE_TIMEOUT = 11 * 60000;

// Route classification for every module, built once the module list is loaded
// (a static import of plugins.mjs would be circular).
let rules = null;
const loadRules = () =>
  (rules ||= import("../plugins.mjs").then((m) => accessRules(m.PLUGINS)));

// Whether this database already has the chain columns (older test databases may not).
const chained = new WeakMap();
const hasChain = (db) => {
  if (!chained.has(db))
    chained.set(db, db.prepare("SELECT 1 FROM pragma_table_info('audit') WHERE name='hash'").get() !== undefined);
  return chained.get(db);
};

const roleLabel = (role) => ROLE_INFO[role]?.label || role;
const userRow = (store, idv) =>
  store.db.prepare("SELECT id,email,name,role,disabled,invited,joined,mfa_secret,password FROM owners WHERE id=?").get(idv);

// Background work started by guest routes (so responses do not depend on
// whether an account exists). Tests wait for it with services.team.idle().
function later(svc, fn) {
  const p = new Promise((resolve) => setImmediate(resolve))
    .then(fn)
    .catch((e) => console.error("Team background task failed:", e.message))
    .finally(() => svc.pending.delete(p));
  svc.pending.add(p);
}

async function confirmOwner(r, b) {
  const store = r.ctx.store;
  r.allow("team-confirm:" + r.session.owner_id, 20, 600000);
  const me = userRow(store, r.session.owner_id);
  check(await verifyPassword(b.password, me.password), "Current password is incorrect.", 403);
  check(verifySecondFactor(store, me.id, b.code), "Authenticator or recovery code is required/invalid.", 403);
  return me;
}

function inviteMail(ctx, user, token, invitedBy) {
  const company = ctx.store.settings().company;
  const link = `${ctx.appUrl}/invite/${token}`;
  return {
    link,
    message: {
      kind: "team-invite",
      to: [user.email],
      subject: `You're invited to the ${company} billing workspace`,
      body: [
        `Hello${user.name ? " " + user.name : ""},`,
        "",
        `${invitedBy} invited you to the ${company} workspace on Nawlogic Invoice as ${roleLabel(user.role).toLowerCase()}.`,
        "",
        "Choose your password with this one-time link. It expires in 7 days:",
        link,
        "",
        "If you were not expecting this invitation, you can ignore this email.",
      ].join("\n"),
      dedupeKey: "team-invite:" + hash(token).slice(0, 40),
    },
  };
}

// Sends an invitation when email is configured; the owner can always copy the link.
async function sendInvite(ctx, user, token, invitedBy) {
  const { link, message } = inviteMail(ctx, user, token, invitedBy);
  if (!ctx.mailer?.status().configured) return { link, emailed: false };
  try {
    await ctx.mailer.deliver(message);
    return { link, emailed: true };
  } catch (e) {
    return { link, emailed: false, emailError: e.message };
  }
}

async function sendReset(ctx, email) {
  const store = ctx.store;
  const u = store.db.prepare("SELECT * FROM owners WHERE email=?").get(email);
  if (!u || u.disabled || (u.invited && !u.joined)) return;
  const token = store.tx(() => {
    const t = store.teamToken(u.id, "reset");
    store.audit("password.reset_requested", String(u.id), "Reset link emailed (valid 30 minutes).");
    return t;
  });
  const company = store.settings().company;
  await ctx.mailer.deliver({
    kind: "password-reset",
    to: [u.email],
    subject: `Reset your ${company} workspace password`,
    body: [
      `Someone asked to reset the password for ${u.email} on the ${company} workspace (Nawlogic Invoice).`,
      "",
      "Choose a new password with this link. It works once and expires in 30 minutes:",
      `${ctx.appUrl}/reset/${token}`,
      "",
      "If you did not ask for this, ignore this email. Your password stays the same.",
      u.mfa_secret ? "Your authenticator code is still needed when you sign in." : "",
    ]
      .join("\n")
      .trim(),
    dedupeKey: "password-reset:" + hash(token).slice(0, 40),
  });
}

function backupState(ctx) {
  const b = configureBackups(ctx.backups, ctx.store);
  return {
    keySource: b.key ? b.keySource || "server" : null,
    directory: b.directory,
    directorySource: b.directorySource || null,
    status: b.status(),
    remote: b.remote?.status() || null,
  };
}

export default {
  name: "team",
  migrations: [
    { name: "team-001-users", sql: USER_MIGRATION },
    { name: "team-002-audit-chain", up: migrateAuditChain },
    { name: "team-003-backups", sql: BACKUP_MIGRATION },
  ],
  secrets: [
    {
      name: "BACKUP_S3_ENDPOINT",
      label: "Off-site backup: endpoint",
      help: "Leave empty for AWS S3. R2: https://<account-id>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com · Wasabi: https://s3.<region>.wasabisys.com · Spaces: https://<region>.digitaloceanspaces.com",
      secret: false,
    },
    {
      name: "BACKUP_S3_REGION",
      label: "Off-site backup: region",
      help: "For example ap-southeast-5 (AWS Malaysia), ap-southeast-1 (AWS or Wasabi Singapore), auto (Cloudflare R2), us-west-004 (B2), sgp1 (Spaces).",
      secret: false,
    },
    { name: "BACKUP_S3_BUCKET", label: "Off-site backup: bucket", help: "A private bucket used only for these backups.", secret: false },
    { name: "BACKUP_S3_PREFIX", label: "Off-site backup: folder", help: "Folder (key prefix) inside the bucket. Default: nawlogic/", secret: false },
    { name: "BACKUP_S3_ACCESS_KEY_ID", label: "Off-site backup: access key ID", help: "A key limited to this bucket.", secret: true },
    { name: "BACKUP_S3_SECRET_ACCESS_KEY", label: "Off-site backup: secret access key", secret: true },
    { name: "BACKUP_S3_KEEP", label: "Off-site backup: copies to keep", help: "Older off-site copies are deleted after each upload. Default: 30", secret: false },
  ],
  attach(Store) {
    attachUsers(Store);
    attachBackups();
    // Chain every new audit entry: insert as before, then seal it with
    // prev_hash/hash in the same transaction.
    const audit = Store.prototype.audit;
    Store.prototype.audit = function (...args) {
      const go = () => {
        const out = audit.apply(this, args);
        if (hasChain(this.db)) sealAudit(this.db);
        if (args[0] === "owner.signed_in" && args[1])
          this.db.prepare("UPDATE owners SET last_sign_in=? WHERE id=?").run(now(), Number(args[1]));
        return out;
      };
      return this._transaction || this.db.isTransaction ? go() : this.tx(go);
    };
  },
  init(ctx) {
    configureBackups(ctx.backups, ctx.store);
    const remote = new RemoteBackups(ctx.store);
    ctx.backups.remote = remote;
    const pending = new Set();
    ctx.services.team = { remote, pending, idle: () => Promise.all([...pending]) };
    loadRules();
  },
  routes: {
    // Every owner API request: the user must still be active, and non-owners
    // may only use routes on their role's allow-list.
    async authorize(r) {
      const store = r.ctx.store;
      const u = userRow(store, r.session.owner_id);
      if (!u || u.disabled || (u.invited && !u.joined)) {
        store.db.prepare("DELETE FROM sessions WHERE hash=?").run(r.session.hash);
        throw new AppError("Please sign in.", 401);
      }
      r.session.role = u.role;
      r.session.name = u.name;
      if (u.role === "owner") return;
      if (!allowed(await loadRules(), u.role, r.method, r.path))
        throw new AppError(`Your ${roleLabel(u.role).toLowerCase()} access does not include this. Ask the workspace owner.`, 403);
    },
    async owner(r) {
      if (!r.path.startsWith("/api/team/")) return false;
      const { store } = r.ctx;
      const { path, method } = r;
      const role = r.session.role;
      const owner = () => check(role === "owner", "Only the workspace owner can do this.", 403);
      const sendJson = (status, data) => (r.send(status, data), true);

      if (path === "/api/team/me" && method === "GET") {
        const u = userRow(store, r.session.owner_id);
        return sendJson(200, { id: u.id, email: u.email, name: u.name, role: u.role, mfa: !!u.mfa_secret });
      }
      if (path === "/api/team/password" && method === "POST") {
        r.allow("team-password:" + r.session.owner_id, 10, 15 * 60000);
        const b = await r.body();
        const u = userRow(store, r.session.owner_id);
        check(await verifyPassword(b.current, u.password), "Current password is incorrect.", 403);
        check(verifySecondFactor(store, u.id, b.code), "Authenticator or recovery code is required/invalid.", 403);
        const password = await passwordHash(b.password);
        store.tx(() => {
          store.db.prepare("UPDATE owners SET password=? WHERE id=?").run(password, u.id);
          store.db.prepare("DELETE FROM sessions WHERE owner_id=?").run(u.id);
          store.db.prepare("DELETE FROM team_tokens WHERE owner_id=? AND purpose='reset' AND used IS NULL").run(u.id);
          // Connector tokens belong to the workspace owner(s).
          if (u.role === "owner") store.db.prepare("UPDATE integration_tokens SET revoked=1").run();
          store.audit("password.changed", String(u.id));
        });
        r.send(200, { ok: true }, { "Set-Cookie": cookie("", r.ctx.secure, true) });
        return true;
      }

      // Users (owner only).
      if (path === "/api/team/users" && method === "GET") {
        owner();
        return sendJson(200, store.teamUsers());
      }
      if (path === "/api/team/users" && method === "POST") {
        owner();
        r.allow("team-invite:" + r.session.owner_id, 30, 3600000);
        const b = await r.body();
        const { user, token } = store.inviteUser(b, r.session.email);
        const sent = await sendInvite(r.ctx, user, token, r.session.email);
        return sendJson(201, { user: store.teamUsers().find((x) => x.id === user.id), ...sent });
      }
      const m = path.match(/^\/api\/team\/users\/(\d{1,9})(?:\/(disable|enable|invite|reset-mfa|reset-link))?$/);
      if (m) {
        owner();
        const [, uid, action] = m;
        if (!action && method === "PUT") {
          store.updateUser(uid, await r.body(), r.session.owner_id);
          return sendJson(200, store.teamUsers().find((x) => x.id === Number(uid)));
        }
        if (!action && method === "DELETE") {
          store.cancelInvite(uid);
          return sendJson(200, { ok: true });
        }
        if (method === "POST" && (action === "disable" || action === "enable")) {
          store.setUserDisabled(uid, action === "disable", r.session.owner_id);
          return sendJson(200, store.teamUsers().find((x) => x.id === Number(uid)));
        }
        if (method === "POST" && action === "invite") {
          r.allow("team-invite:" + r.session.owner_id, 30, 3600000);
          const { user, token } = store.resendInvite(uid);
          const sent = await sendInvite(r.ctx, user, token, r.session.email);
          return sendJson(200, { user: store.teamUsers().find((x) => x.id === user.id), ...sent });
        }
        // A member forgot their password. With email the link goes to them only;
        // without email the owner gets it to pass on (it is audited).
        if (method === "POST" && action === "reset-link") {
          r.allow("team-reset-link:" + r.session.owner_id, 20, 3600000);
          const u = store.teamUser(uid);
          check(u.id !== r.session.owner_id, "Change your own password under Settings.", 409);
          check(!u.disabled && (!u.invited || u.joined), "Only active users can reset a password. Resend the invitation instead.", 409);
          if (r.ctx.mailer?.status().configured) {
            await sendReset(r.ctx, u.email);
            return sendJson(200, { emailed: true, email: u.email });
          }
          const token = store.tx(() => {
            const t = store.teamToken(u.id, "reset");
            store.audit("password.reset_link_created", String(u.id), `${u.email}: link given to ${r.session.email} (email not configured)`);
            return t;
          });
          return sendJson(200, { emailed: false, email: u.email, link: `${r.ctx.appUrl}/reset/${token}` });
        }
        if (method === "POST" && action === "reset-mfa") {
          await confirmOwner(r, await r.body());
          store.resetUserMfa(uid, r.session.owner_id);
          return sendJson(200, store.teamUsers().find((x) => x.id === Number(uid)));
        }
      }

      // Audit chain (owner and accountant).
      if (path === "/api/team/audit/verify" && method === "GET") {
        check(role === "owner" || role === "accountant", "Only the owner or an accountant can verify the audit chain.", 403);
        r.allow("team-verify:" + r.session.owner_id, 30, 60000);
        const q = r.url.searchParams;
        const expect = q.get("id") || q.get("hash") ? { id: q.get("id"), hash: (q.get("hash") || "").trim() } : null;
        if (expect) check(/^\d{1,12}$/.test(expect.id || "") && /^[0-9a-fA-F]{64}$/.test(expect.hash), "Enter the entry number and the 64-character hash you recorded.");
        return sendJson(200, { ...verifyAuditChain(store.db, expect), verified: now() });
      }
      if (path === "/api/team/audit/head" && method === "GET") {
        check(role === "owner" || role === "accountant", "Only the owner or an accountant can export the chain head.", 403);
        const head = chainHead(store.db);
        const body = {
          workspace: store.settings().company,
          id: head.id,
          hash: head.hash,
          entry_created: head.created,
          entries: head.entries,
          exported: now(),
          exported_by: r.session.email,
          how_to_check: "Keep this file. Later, Audit > Check a recorded head (or `node server/cli.mjs audit-verify <id> <hash>`) confirms that history up to this entry is unchanged.",
        };
        if (r.url.searchParams.get("download") === "1")
          r.send(200, JSON.stringify(body, null, 2), {
            "Content-Disposition": `attachment; filename="audit-chain-head-${head.id}.json"`,
          });
        else r.send(200, body);
        return true;
      }

      // Backups (owner only).
      if (path === "/api/team/backup/key" && method === "POST") {
        owner();
        const b = await r.body();
        const backups = configureBackups(r.ctx.backups, store);
        check(!backups.key, backups.keySource === "server" ? "BACKUP_KEY is set on the server." : "A backup key already exists.", 409);
        await confirmOwner(r, b);
        const key = randomBytes(32).toString("base64");
        store.setSecret("BACKUP_KEY", key);
        configureBackups(backups, store);
        store.audit("backup.key_generated", null, "Backup key generated in Settings and shown once.");
        // Start the daily schedule now if the server asked for it at start-up.
        if (backups.startRequested && !backups.timer && backups.status().configured) backups.start();
        return sendJson(201, { key, directory: backups.directory, configured: backups.status().configured });
      }
      if (path === "/api/team/backup/test" && method === "POST") {
        owner();
        r.allow("team-backup-test:" + r.session.owner_id, 10, 600000);
        // Storage calls can take minutes; keep the response open past the default 20 s.
        r.res.setTimeout(REMOTE_TIMEOUT);
        return sendJson(200, await r.ctx.backups.remote.test());
      }
      if (path === "/api/team/backup/remote" && method === "GET") {
        owner();
        r.allow("team-backup-list:" + r.session.owner_id, 20, 600000);
        r.res.setTimeout(REMOTE_TIMEOUT);
        return sendJson(200, await r.ctx.backups.remote.list());
      }
      if (path === "/api/team/backup/upload" && method === "POST") {
        owner();
        r.allow("team-backup-upload:" + r.session.owner_id, 10, 600000);
        r.res.setTimeout(REMOTE_TIMEOUT);
        const latest = await latestLocalBackup(configureBackups(r.ctx.backups, store));
        check(latest, "There is no local backup to upload yet. Run a backup first.", 409);
        const out = await r.ctx.backups.remote.upload(latest.path);
        return sendJson(200, { ...out, filename: latest.filename });
      }
      return false;
    },
    // Sign-in helpers without a session: invitations and password reset.
    async guest(r) {
      if (!r.path.startsWith("/api/guest/team/")) return false;
      const { ctx, path, method } = r;
      const { store } = ctx;
      const svc = ctx.services.team;
      if (path === "/api/guest/team/options" && method === "GET") {
        r.allow("team-guest:" + r.ip, 60, 60000);
        r.send(200, { reset: !!ctx.mailer?.status().configured });
        return true;
      }
      if (path === "/api/guest/team/reset" && method === "POST") {
        // The same answer whether or not the account exists; the work happens
        // after the response so timing does not tell either.
        r.allow("team-reset:" + r.ip, 5, 15 * 60000);
        const b = await r.body();
        const email = normalEmail(b.email);
        r.allow("team-reset-email:" + hash(email), 3, 3600000);
        const mail = !!ctx.mailer?.status().configured;
        if (mail) later(svc, () => requestContext.run({ actor: "password-reset" }, () => sendReset(ctx, email)));
        r.send(202, { ok: true, email: mail });
        return true;
      }
      const m = path.match(/^\/api\/guest\/team\/(reset|invite)\/([\w-]{1,100})$/);
      if (m) {
        const [, kind, token] = m;
        r.allow("team-link:" + r.ip, 30, 15 * 60000);
        if (method === "GET") {
          const u = store.teamTokenUser(token, kind);
          r.send(200, {
            email: u.email,
            name: u.name,
            role: u.role,
            role_label: roleLabel(u.role),
            company: store.settings().company,
            mfa: kind === "reset" ? !!u.mfa_secret : false,
          });
          return true;
        }
        if (method === "POST") {
          r.allow("team-link-submit:" + r.ip, 10, 15 * 60000);
          const b = await r.body();
          const u = store.teamTokenUser(token, kind);
          requestContext.getStore().actor = `${kind}-link:${u.email}`;
          const out =
            kind === "invite"
              ? await store.acceptInvite(token, b, passwordHash)
              : await store.resetPassword(token, b, passwordHash);
          r.send(200, { ok: true, ...out });
          return true;
        }
      }
      throw new AppError("Not found.", 404);
    },
  },
  workspace(r) {
    const { store } = r.ctx;
    const u = userRow(store, r.session.owner_id);
    const out = {
      me: { id: u.id, email: u.email, name: u.name, role: u.role, mfa: !!u.mfa_secret },
      roles: ROLE_INFO,
      mail: !!r.ctx.mailer?.status().configured,
    };
    if (u.role === "owner" || u.role === "accountant") out.audit = chainHead(store.db);
    if (u.role === "owner") {
      out.users = store.teamUsers();
      out.backup = backupState(r.ctx);
    }
    return out;
  },
  exportData(store) {
    return {
      users: store.teamUsers().map((u) => ({
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        invited: u.invited,
        joined: u.joined,
        last_sign_in: u.last_sign_in,
      })),
      audit_chain_head: chainHead(store.db),
    };
  },
  // A restored copy must not honour invitation or reset links issued before.
  onRestore(db) {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='team_tokens'").get())
      db.exec("DELETE FROM team_tokens");
  },
};

