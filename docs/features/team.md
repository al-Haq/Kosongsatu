# Team and security

Users and roles (with read-only accountant access), password reset by email, a QR code for authenticator setup, off-site backups and a verifiable audit chain. Roadmap items 61, 74, 76, 77, 79 and 98.

## Users and roles (61, 76)

The person who ran `npm run setup` is the first **owner**. Open **Team** (Workspace menu) to invite more people.

| Role | Can | Cannot |
|---|---|---|
| **Owner** | Everything. | Remove, demote or disable the last active owner. |
| **Staff** | Day-to-day billing: clients and services (add, edit, archive), drafts (create, edit, delete), issue, client links, email documents and statements, record payments and receipts, allocate receipts, bank import and matching, recurring schedules, sales and customer POs, upload files. | Settings, integration keys, users, connectors, AI assistant and automation, backups, voids, credit/debit notes, refunds, payment reversals, deleting clients/services/schedules, the JSON export, other people's MFA. |
| **Accountant** | Read-only: see everything, download PDFs, invoice and SST CSVs, the JSON business export and statements; verify the audit chain. | Any change, except their own password and authenticator. |

- **Invite:** Team → **Invite user** → email, name, role. With email configured, the invitation is emailed; you can also copy the link. Without email, copy the one-time link and send it yourself (WhatsApp, etc.). The link lets them choose a password, works once and expires after 7 days. **Send again** replaces the link; **Remove** cancels a pending invitation.
- **Change role / name:** **Edit**. A new role applies to the person's next click; they don't need to sign in again.
- **Disable:** signs the person out everywhere at once and blocks sign-in. **Enable** restores access with their old password. Active users are disabled rather than deleted, so the audit trail keeps its meaning.
- **Last sign-in** is shown for each user.
- **Reset password:** for a member who forgot theirs. With email it goes straight to them (you never see it); without email you get a 30-minute one-time link to pass on, and creating it is recorded in the audit trail.
- **Reset MFA:** clears a member's authenticator and recovery codes (lost phone) and signs them out. Needs your password (and your code if you use MFA).
- Staff and accountants use **My account** for their password and authenticator. The Settings and Automation pages are hidden for them, and so are buttons they can't use. The server checks every request independently of what the screen shows.
- Audit entries record who did what as `owner:<email>` for every user (the prefix is historical; it is the signed-in person's email).

**Security model.** Permissions are enforced on the server with an allow-list per role (`server/team-roles.mjs`). Any route that isn't on the list is refused for staff and accountants, so new features stay owner-only until someone classifies them.

## Password reset by email (77)

Needs email (SMTP) configured on the server. The sign-in page has **Forgot password?**:

- Enter the sign-in email. The answer is always the same ("if an account exists…"), whether or not the email belongs to a user, and the email is sent after the reply, so the page can't be used to discover accounts.
- The link works **once** and expires after **30 minutes**. A newer request replaces an older link. Only a SHA-256 hash of the link is stored.
- Limits: 5 requests per 15 minutes per network address, 3 per hour per email address.
- Setting the new password signs that person out everywhere. For an owner it also revokes all connector (MCP/n8n) tokens, as a normal password change does.
- **MFA is still required** at the next sign-in. Disabled users and pending invitations cannot reset.

An owner can change a member's sign-in email in **Team → Edit**; their password, MFA and role stay, and the audit records `user.email_changed`. The console command `node server/cli.mjs set-email <current> <new>` does the same for any account, including your own.

An operator with server access can also add an active user directly, with a generated password: `node server/cli.mjs add-user <email> [owner|staff|accountant] [name]` (see "Adding a user from the console" in docs/DEPLOYMENT.md).

Without email, **Forgot password?** explains the alternatives: members ask the owner for a reset link (Team → Reset password); the owner's server operator runs `npm run recover` on the server, which now asks for the account email (useful when there are several users).

## QR code for authenticator setup (74)

Settings (owner) or My account (others) → **Enable MFA**. After your password, the setup screen shows a QR code of the `otpauth://` link (issuer *Nawlogic*, your email) next to the setup key. Scan it with Google Authenticator, Microsoft Authenticator, 1Password, etc., then type a 6-digit code. Each user has their own authenticator and recovery codes.

## Encrypted backups and off-site copies (79)

Settings → **Encrypted backups**.

### 1. Turn on backups

- If `BACKUP_KEY` is set on the server, it is used (and `BACKUP_DIRECTORY` if set).
- Otherwise click **Generate backup key**. The key is shown **once**: save it in your password manager, away from this server. It is stored encrypted (with the server's MFA key file) so backups can run, and is never shown again. Backups go to `data/backups/` next to the database unless `BACKUP_DIRECTORY` is set.
- A backup runs when the server starts and every 24 hours; **Run backup now** runs one immediately. The newest 7 files stay on the server.

**Without the backup key, a backup cannot be restored by anyone, including you.** The key is inside the database it protects, so a copy of the database or server does not help if the server is lost.

### 2. Add off-site storage

After every backup, the encrypted `.nwlbackup` file is uploaded to S3-compatible storage. The provider only ever receives ciphertext. Create a **private bucket** used only for this, and an access key limited to it. Then fill in Settings → **Integration keys** → *Off-site backup: …*:

| Provider | Endpoint | Region |
|---|---|---|
| AWS S3 | leave empty | `ap-southeast-5` (Malaysia) or `ap-southeast-1` (Singapore) |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` (as in the endpoint) |
| Wasabi | `https://s3.<region>.wasabisys.com` | e.g. `ap-southeast-1` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | e.g. `sgp1` |

Also: **bucket**, **access key ID**, **secret access key**, optional **folder** (default `nawlogic/`) and **copies to keep** (default 30, 1–365). The same names work as server environment variables (`BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_KEEP`), and the environment wins.

The key needs: upload, download, list and delete in that folder. For AWS, an IAM policy like:

```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/nawlogic/*" },
  { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::YOUR-BUCKET", "Condition": { "StringLike": { "s3:prefix": "nawlogic/*" } } }
] }
```

Click **Test connection**: it uploads, downloads, lists and deletes a small test file and tells you which step failed. The panel shows the provider, bucket, last upload (time, file, size) and the last failure. After each upload, copies beyond the retention count are deleted; only files named `nawlogic-….nwlbackup` in the folder are ever deleted. A failed upload never fails the local backup; it is recorded and **Upload latest again** retries it. **Show off-site copies** lists what is stored.

Requests are signed with AWS Signature Version 4 using Node's built-in crypto (no SDK); the signer is tested against AWS's published test vectors. Custom endpoints must use HTTPS (plain HTTP is accepted only for a local MinIO on `localhost`/`127.0.0.1`). AWS without an endpoint uses `https://<bucket>.s3.<region>.amazonaws.com`; custom endpoints use path-style URLs.

### 3. Restore from an off-site copy

On the new server, with the app stopped:

```sh
# Storage settings as environment variables (or a .env file):
BACKUP_S3_ENDPOINT=… BACKUP_S3_REGION=… BACKUP_S3_BUCKET=… \
BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=… \
node server/cli.mjs remote-backups                       # list copies
node server/cli.mjs fetch-backup nawlogic-2026-….nwlbackup ./restore.nwlbackup
BACKUP_KEY='the key from your password manager' \
npm run restore -- ./restore.nwlbackup ./data/restored.sqlite
```

Then follow the restore steps in docs/DEPLOYMENT.md (MFA key file, `DATABASE_PATH`). Restoring signs everyone out, revokes client links, connector tokens and unused invitation/reset links.

## Verifiable audit chain (98)

Every audit entry now carries `prev_hash` and `hash` = SHA-256 of the previous entry's hash and the entry itself (number, time, actor, action, record, detail, before/after data). Existing history was sealed into the chain when this module was installed. Entries still cannot be edited or deleted through the app (database guards).

**Audit** page (owner and accountant):

- **Verify audit chain** re-computes every hash and reports **OK**, or the first entry that was changed, removed, added or reordered.
- **Download chain head** saves a small file with the latest entry number, its hash and time. Your accountant (or you) should keep these, for example at each month end, somewhere outside the server: their own files, an email, a printout.
- **Check a recorded head** confirms that history up to a recorded entry is unchanged.
- Console: `npm run audit-verify` or `node server/cli.mjs audit-verify` (optionally `audit-verify <entry> <hash>` to check a recorded head) and `node server/cli.mjs audit-head`. It opens the database read-only, needs no keys, and exits with code 1 if the chain is broken.

**What it proves, honestly.** If someone changes the database directly after the fact, verification finds the first entry that no longer fits, **as long as you can compare against a chain head recorded earlier**. Someone with full control of the server could rewrite history *and* recompute every later hash; the chain then looks consistent on its own. That is why a head kept outside the server matters: a rewritten history no longer matches it. Removing the newest entries is likewise only visible against a recorded head.

It does **not** prove that what an entry says was true when written, it cannot show changes made before the chain began, and it does not stop someone with server access from deleting the whole database (that is what off-site backups are for).

## For developers

- Module files: `server/ext/team.mjs`, `server/team-{roles,users,audit,backup,s3,cli}.mjs`, `public/ext/team.mjs`/`.css`.
- Migrations: `team-001-users` (role, name, disabled, invited, invited_by, joined, last_sign_in on `owners`; `team_tokens`), `team-002-audit-chain` (columns, back-fill, guards that allow only sealing an unsealed entry once), `team-003-backups` (`team_backup_uploads`, `team_state`).
- `Store.prototype.audit` is wrapped: the original insert runs, then the entry is sealed in the same transaction. Raw inserts (console recovery) are sealed by the next write.
- **Classifying routes of other modules:** export `access` from a server module:
  ```js
  export default { name: "books", access: {
    accountant: [["GET", /^\/api\/books\/reports(\/[\w-]+)?$/]],
    staff: [["POST", /^\/api\/books\/expenses$/]],
  } };
  ```
  Unlisted routes are owner-only.
- **Hiding UI by role:** a browser module may return `can(kind, name)` (kind `"nav"`, `"page"` or `"action"`); returning `false` hides the nav entry, blocks the page or drops buttons made with `h.button`. The team module uses it for roles.
- Owner routes: `GET/POST /api/team/users`, `PUT/DELETE /api/team/users/:id`, `POST /api/team/users/:id/{disable,enable,invite,reset-link,reset-mfa}`, `POST /api/team/password` (any user, own password), `GET /api/team/me`, `GET /api/team/audit/{verify,head}` (owner, accountant), `POST /api/team/backup/{key,test,upload}`, `GET /api/team/backup/remote`. Guest: `GET /api/guest/team/options`, `POST /api/guest/team/reset`, `GET/POST /api/guest/team/{reset,invite}/:token`. Pages: `/reset/<token>`, `/invite/<token>`.

## Limits

- One workspace with several users; not multi-company.
- Without email, invitations and member resets need the owner to pass on links.
- Backup scheduling runs inside the app process; if the server is down, no backup runs. The backup key generated in Settings is stored on the same server, encrypted with the MFA key file: keep your own copy.
- The chain makes tampering detectable against recorded heads; it does not make it impossible.
