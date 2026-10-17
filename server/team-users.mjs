// Users of the workspace. The core `owners` table is the user list; this module
// adds roles, names, invitations, disabling and one-time links (invites and
// password resets, stored only as SHA-256 hashes).
import { randomBytes } from "node:crypto";
import { check, text, hash, now, AppError } from "./domain.mjs";
import { ROLES } from "./team-roles.mjs";

export const INVITE_TTL = 7 * 24 * 3600000;
export const RESET_TTL = 30 * 60000;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const USER_MIGRATION = `
ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','staff','accountant'));
ALTER TABLE owners ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE owners ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owners ADD COLUMN invited TEXT;
ALTER TABLE owners ADD COLUMN invited_by TEXT;
ALTER TABLE owners ADD COLUMN joined TEXT;
ALTER TABLE owners ADD COLUMN last_sign_in TEXT;
CREATE TABLE team_tokens(hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('invite','reset')), expires INTEGER NOT NULL, used TEXT, created TEXT NOT NULL);
CREATE INDEX team_tokens_owner_idx ON team_tokens(owner_id, purpose);
`;

// A password hash in the stored format that no password produces, for users
// who have been invited but have not chosen a password yet.
const unusablePassword = () => randomBytes(16).toString("hex") + ":" + randomBytes(64).toString("hex");
export const normalEmail = (v) => {
  const email = text(v || "", 160, true).toLowerCase();
  check(EMAIL.test(email), "Enter a valid email address.");
  return email;
};
const role = (v) => {
  check(ROLES.includes(v), "Choose owner, staff or accountant.");
  return v;
};
export const userStatus = (u) => (u.disabled ? "Disabled" : u.invited && !u.joined ? "Invited" : "Active");

export function attachUsers(Store) {
  Object.assign(Store.prototype, {
    teamUser(idv) {
      const u = this.db.prepare("SELECT * FROM owners WHERE id=?").get(Number(idv));
      check(u, "User not found.", 404);
      return u;
    },
    teamUsers() {
      return this.db
        .prepare(
          "SELECT o.id,o.email,o.name,o.role,o.disabled,o.invited,o.invited_by,o.joined,o.last_sign_in,o.mfa_secret IS NOT NULL mfa,(SELECT count(*) FROM sessions s WHERE s.owner_id=o.id AND s.expires>?) sessions FROM owners o ORDER BY o.id",
        )
        .all(Date.now())
        .map((u) => ({ ...u, mfa: !!u.mfa, disabled: !!u.disabled, status: userStatus(u) }));
    },
    // Owners who can still sign in. The last one can never be demoted, disabled or removed.
    activeOwners() {
      return this.db
        .prepare("SELECT count(*) n FROM owners WHERE role='owner' AND disabled=0 AND (invited IS NULL OR joined IS NOT NULL)")
        .get().n;
    },
    // A new one-time link replaces any unused link of the same purpose.
    teamToken(ownerId, purpose) {
      const token = randomBytes(32).toString("base64url");
      this.db.prepare("DELETE FROM team_tokens WHERE owner_id=? AND purpose=? AND used IS NULL").run(ownerId, purpose);
      this.db
        .prepare("INSERT INTO team_tokens(hash,owner_id,purpose,expires,created) VALUES(?,?,?,?,?)")
        .run(hash(token), ownerId, purpose, Date.now() + (purpose === "invite" ? INVITE_TTL : RESET_TTL), now());
      return token;
    },
    // The user behind a valid, unused link (without using it up).
    teamTokenUser(token, purpose) {
      check(typeof token === "string" && /^[\w-]{43}$/.test(token), "This link is invalid or has expired.", 404);
      const row = this.db
        .prepare(
          "SELECT o.*,t.hash token_hash FROM team_tokens t JOIN owners o ON o.id=t.owner_id WHERE t.hash=? AND t.purpose=? AND t.used IS NULL AND t.expires>?",
        )
        .get(hash(token), purpose, Date.now());
      check(row && !row.disabled, "This link is invalid or has expired.", 404);
      if (purpose === "reset") check(!row.invited || row.joined, "This link is invalid or has expired.", 404);
      if (purpose === "invite") check(row.invited && !row.joined, "This invitation was already used.", 404);
      return row;
    },
    // Marks the link used. Exactly one caller wins; any other gets a 404.
    useTeamToken(token, purpose) {
      const u = this.teamTokenUser(token, purpose);
      const used = this.db
        .prepare("UPDATE team_tokens SET used=? WHERE hash=? AND purpose=? AND used IS NULL AND expires>?")
        .run(now(), hash(token), purpose, Date.now());
      check(used.changes === 1, "This link is invalid or has expired.", 404);
      return u;
    },
    inviteUser(b, invitedBy) {
      const email = normalEmail(b.email);
      const r = role(b.role || "staff");
      const name = text(b.name || "", 120);
      check(
        !this.db.prepare("SELECT id FROM owners WHERE email=?").get(email),
        "A user with this email already exists.",
        409,
      );
      return this.tx(() => {
        const info = this.db
          .prepare("INSERT INTO owners(email,password,role,name,invited,invited_by) VALUES(?,?,?,?,?,?)")
          .run(email, unusablePassword(), r, name, now(), invitedBy);
        const idv = Number(info.lastInsertRowid);
        const token = this.teamToken(idv, "invite");
        this.audit("user.invited", String(idv), `${email} as ${r}`, null, { email, name, role: r });
        return { user: this.teamUser(idv), token };
      });
    },
    resendInvite(idv) {
      const u = this.teamUser(idv);
      check(u.invited && !u.joined && !u.disabled, "Only pending invitations can be sent again.", 409);
      return this.tx(() => {
        this.db.prepare("UPDATE owners SET invited=? WHERE id=?").run(now(), u.id);
        const token = this.teamToken(u.id, "invite");
        this.audit("user.invite_resent", String(u.id), u.email);
        return { user: this.teamUser(u.id), token };
      });
    },
    cancelInvite(idv) {
      const u = this.teamUser(idv);
      check(u.invited && !u.joined, "Only pending invitations can be removed. Disable an active user instead.", 409);
      this.tx(() => {
        for (const t of ["team_tokens", "sessions", "recovery_codes"])
          this.db.prepare(`DELETE FROM ${t} WHERE owner_id=?`).run(u.id);
        this.db.prepare("DELETE FROM owners WHERE id=?").run(u.id);
        this.audit("user.invite_cancelled", String(u.id), u.email, { email: u.email, role: u.role }, null);
      });
    },
    async acceptInvite(token, b, passwordHash) {
      this.teamTokenUser(token, "invite");
      const password = await passwordHash(b.password);
      const name = b.name === undefined ? null : text(b.name, 120);
      return this.tx(() => {
        const u = this.useTeamToken(token, "invite");
        this.db
          .prepare("UPDATE owners SET password=?,joined=?,name=COALESCE(?,name) WHERE id=?")
          .run(password, now(), name || null, u.id);
        this.db.prepare("DELETE FROM sessions WHERE owner_id=?").run(u.id);
        this.audit("user.joined", String(u.id), `${u.email} as ${u.role}`);
        return { email: u.email };
      });
    },
    async resetPassword(token, b, passwordHash) {
      this.teamTokenUser(token, "reset");
      const password = await passwordHash(b.password);
      return this.tx(() => {
        const u = this.useTeamToken(token, "reset");
        this.db.prepare("UPDATE owners SET password=? WHERE id=?").run(password, u.id);
        // Every session ends; owners' connector tokens are revoked as with a password change.
        this.db.prepare("DELETE FROM sessions WHERE owner_id=?").run(u.id);
        this.db.prepare("DELETE FROM team_tokens WHERE owner_id=? AND purpose='reset' AND used IS NULL").run(u.id);
        if (u.role === "owner") this.db.prepare("UPDATE integration_tokens SET revoked=1 WHERE revoked=0").run();
        this.audit(
          "password.reset",
          String(u.id),
          u.role === "owner" ? "Reset by email link; sessions ended; connector tokens revoked." : "Reset by email link; sessions ended.",
        );
        return { email: u.email, mfa: !!u.mfa_secret };
      });
    },
    updateUser(idv, b, actorId) {
      const u = this.teamUser(idv);
      const next = {
        role: b.role === undefined ? u.role : role(b.role),
        name: b.name === undefined ? u.name : text(b.name, 120),
      };
      if (u.role === "owner" && next.role !== "owner" && !u.disabled && (!u.invited || u.joined))
        check(this.activeOwners() > 1, "The workspace needs at least one owner. Make someone else an owner first.", 409);
      return this.tx(() => {
        this.db.prepare("UPDATE owners SET role=?,name=? WHERE id=?").run(next.role, next.name, u.id);
        if (next.role !== u.role)
          this.audit("user.role_changed", String(u.id), `${u.email}: ${u.role} → ${next.role}`, { role: u.role }, { role: next.role });
        if (next.name !== u.name) this.audit("user.renamed", String(u.id), u.email, { name: u.name }, { name: next.name });
        return this.teamUser(u.id);
      });
    },
    setUserDisabled(idv, disabled, actorId) {
      const u = this.teamUser(idv);
      if (disabled) {
        check(u.id !== Number(actorId), "You cannot disable your own account.", 409);
        if (u.role === "owner" && !u.disabled && (!u.invited || u.joined))
          check(this.activeOwners() > 1, "The workspace needs at least one owner. Make someone else an owner first.", 409);
      }
      return this.tx(() => {
        this.db.prepare("UPDATE owners SET disabled=? WHERE id=?").run(disabled ? 1 : 0, u.id);
        if (disabled) {
          this.db.prepare("DELETE FROM sessions WHERE owner_id=?").run(u.id);
          this.db.prepare("DELETE FROM team_tokens WHERE owner_id=? AND used IS NULL").run(u.id);
        }
        this.audit(disabled ? "user.disabled" : "user.enabled", String(u.id), u.email + (disabled ? "; sessions ended" : ""));
        return this.teamUser(u.id);
      });
    },
    // The owner clears another user's authenticator (lost phone). The user
    // signs in with their password and enrols again.
    resetUserMfa(idv, actorId) {
      const u = this.teamUser(idv);
      check(u.id !== Number(actorId), "Manage your own authenticator under Settings.", 409);
      check(u.mfa_secret || u.mfa_pending, "This user has no authenticator set up.", 409);
      this.tx(() => {
        this.db
          .prepare("UPDATE owners SET mfa_secret=NULL,mfa_pending=NULL,mfa_pending_expires=NULL,mfa_step=-1 WHERE id=?")
          .run(u.id);
        this.db.prepare("DELETE FROM recovery_codes WHERE owner_id=?").run(u.id);
        this.db.prepare("DELETE FROM sessions WHERE owner_id=?").run(u.id);
        this.audit("user.mfa_reset", String(u.id), `${u.email}; sessions ended`);
      });
    },
  });
}

export function assertActive(u) {
  if (!u || u.disabled) throw new AppError("Please sign in.", 401);
}
