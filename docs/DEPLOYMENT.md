# Deployment and operations

## Shape

The app is a single Node.js 24 process serving same-origin browser assets, a JSON API and generated PDFs. SQLite is stored outside the public asset directory, with foreign keys, WAL and transactional document/payment operations. Use one writable persistent volume and a single app instance. This release is intended for one business/owner. Move to a server database and add proper staff roles before scaling to multiple writers or companies.

Only `pdfkit` and its locked transitive packages are installed; the browser is dependency-free ES modules. System-independent DejaVu font files are bundled, with their license, for multilingual PDF text. Keep the lockfile and install with `npm ci`.

## Before real use

1. Back up and preserve the database. Set a strong owner password and keep the account email reachable; password reset by email is not implemented.
2. Confirm the business name, registration, address, contact details and bank instructions in Settings. Issued documents keep their original snapshots.
3. Test the published invoice PDF and client link with non-sensitive sample data.
4. Configure a TLS reverse proxy, an exact HTTPS `APP_URL`, `NODE_ENV=production`, and persistent storage. Cookie security is enabled in production; HTTP production startup is rejected.
5. Restrict direct access to the Node port. Use a reverse-proxy allowlist for the expected hostname. Rate limiting uses the direct peer IP and deliberately does not trust forwarded headers. Behind one proxy, limits are shared across users; configure edge rate limiting as needed.
6. Confirm any SST/e-Invoice obligations separately. There is no MyInvois validation in this release, and voiding a document here is not a tax credit-note process.

## Environment

| Variable        | Default                  | Purpose                                                         |
| --------------- | ------------------------ | --------------------------------------------------------------- |
| `HOST`          | `127.0.0.1`              | Binding address; container binds `0.0.0.0`                      |
| `PORT`          | `3000`                   | App HTTP port                                                   |
| `APP_URL`       | `http://localhost:3000`  | Exact browser origin for CSRF checks and generated client links |
| `DATABASE_PATH` | `./data/nawlogic.sqlite` | Persistent SQLite path                                          |
| `NODE_ENV`      | development              | `production` requires HTTPS and sets Secure cookies             |

No external service key is required. Never commit `.env`, SQLite files, exports, invoices containing real customer data, or payment instructions.

## Docker (deployment template, validate in your environment)

```sh
docker build -t nawlogic-invoice .
docker volume create nawlogic-data
docker run --rm -it -v nawlogic-data:/app/data nawlogic-invoice npm run setup
# Use an HTTPS reverse proxy in front; bind the container port to loopback.
docker run -d --name nawlogic-invoice --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v nawlogic-data:/app/data \
  -e NODE_ENV=production -e APP_URL=https://invoice.your-domain.example \
  nawlogic-invoice
```

Use your real domain instead of the example. Start without `NODE_ENV=production` only for local validation; never expose that configuration as a public service. The app image runs as the unprivileged `node` user. Docker template commands have to be validated on the chosen host; no infrastructure is provisioned by this repository.

## Backup and restore

The owner-only JSON export contains documents, clients, services, payment history and the latest 150 audit events. It omits password/session secrets and is **not** a full restore image. Full records, owners, link token hashes and all audit entries are in SQLite.

For a consistent full backup, either stop the app and copy `data/nawlogic.sqlite` **together with any `-wal` / `-shm` sidecars**, or use SQLite's online backup API/CLI. Do not copy just the main file while the app is writing in WAL mode.

Recommended with the SQLite CLI on the host:

```sh
sqlite3 data/nawlogic.sqlite ".backup '/private-backup-path/nawlogic.sqlite'"
```

Encrypt off-host backups and restrict file permissions. A full database backup contains private customer information, active sessions and client access hashes. For restore: stop the app, move the restored main database into the configured path, remove only the old database's stale sidecars, restore file ownership, start on a private interface and verify clients, totals, PDFs and audit history. Invalidate sessions and rotate/revoke client links if the backup might have been exposed.

## Audit and corrections

Drafts can change. Issued documents are locked. Reverse incorrectly recorded payments with a reason; do not delete ledger rows. A reversed reference remains reserved on that invoice, so a correction should use an explicitly distinguishable new reference. Void is blocked while payments remain confirmed and revokes the client link. Converted quotations cannot be voided through this simple path.

The stored acceptance is an interaction record, not an advanced digital signature or independent verification of the signer's identity. Links are bearer credentials: restrict forwarding and revoke if leaked. Portal access does not expose the owner API, another client's documents, internal notes on payments, or the audit log.

## Limits and next steps

Scrypt password hashing and HttpOnly/SameSite session cookies are implemented, but MFA/recovery/staff permissions require a later release. The server serves no user uploads. Add private malware-scanned storage and document-level authorization before adding payment-slip attachments. A payment gateway must validate signed callbacks and use idempotency before changing balances. MyInvois needs its own validated document lifecycle.
