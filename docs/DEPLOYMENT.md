# Deployment and operations

## Shape

Use Node.js 24, one app instance and one writable persistent SQLite volume outside the public directory. The same-origin API uses foreign keys, WAL and transactions. Browser assets require no frontend build. Install locked dependencies with `npm ci`. Multiple staff, companies and server replicas are outside this release.

## Before real use

1. Run `npm run setup`, save the generated password privately, change it in Settings and enable MFA. Save the ten recovery codes in your password manager.
2. Complete the company registration, business address, contact and bank instructions. Real issuance requires registration, address and at least one contact. Issued documents retain their snapshots.
3. Test PDFs, customer links and payment corrections with disposable data. Review any migrated legacy duplicates and recurring dates.
4. Use a TLS reverse proxy, exact HTTPS `APP_URL`, `NODE_ENV=production` and persistent storage. Production requires HTTPS and Secure cookies.
5. Restrict the Node port to the proxy. Apply expected-host and edge rate limits. App rate limits use the direct peer IP and do not trust forwarded headers; requests behind one proxy share that limit.
6. Configure encrypted backups and a separate off-host copy; complete a disposable restore drill. Preserve the MFA key separately from the database.
7. Review SST/MyInvois obligations separately. Commercial notes and invoice voids in this app are not validated tax submissions.

## Environment

| Variable             | Default                                        | Purpose                                                         |
| -------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`                                    | Bind address; container uses `0.0.0.0`                          |
| `PORT`               | `3000`                                         | HTTP port                                                       |
| `APP_URL`            | `http://localhost:3000`                        | Exact browser origin and customer link origin                   |
| `DATABASE_PATH`      | `./data/nawlogic.sqlite`                       | Persistent SQLite path                                          |
| `NODE_ENV`           | development                                    | `production` requires explicit HTTPS                            |
| `MFA_ENCRYPTION_KEY` | Generated private `DATABASE_PATH.mfa-key` file | Independent 32-byte base64 server key for authenticator secrets |
| `BACKUP_DIRECTORY`   | unset                                          | Private directory for encrypted backup files                    |
| `BACKUP_KEY`         | unset                                          | Independent 32-byte base64 backup encryption key                |

Generate each key independently:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store keys in a private environment/secret manager, never Git. Do not casually rotate either encryption key: existing ciphertext needs its original key. If no MFA env key is supplied, preserve the generated `.mfa-key` file with permissions `0600`. Back it up separately and securely. The backup key does not replace the MFA key.

Never commit `.env`, databases, key files, encrypted backups, exports, customer invoices or real bank instructions. No external service credential is required for local billing.

## Docker template

Validate on the chosen host; infrastructure is not provisioned here.

```sh
docker build -t nawlogic-invoice .
docker volume create nawlogic-data
docker run --rm -it -v nawlogic-data:/app/data nawlogic-invoice npm run setup
# Provide real secrets through an operator-controlled file or secret manager.
docker run -d --name nawlogic-invoice --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v nawlogic-data:/app/data \
  --env-file /private/nawlogic-production.env \
  nawlogic-invoice
```

Set `NODE_ENV=production` and your real HTTPS `APP_URL` in the private environment. Mount a writable persistent backup directory if backups are enabled. The app runs as the unprivileged `node` user; volume/key permissions must permit that user only. Keep the TLS proxy in front of the loopback-bound port.

## Encrypted backup and restore

With both backup variables configured, `npm start` creates an encrypted online SQLite snapshot on startup and every 24 hours while running, retaining seven encrypted files. Settings shows configured/last-success/error status for the current server session and provides **Run backup now**. No backup is claimed when configuration is absent. Monitor disk space and copy successful encrypted files off-host under your retention policy. Keys must be recoverable independently of the failed host.

Manual backup with the same environment:

```sh
npm run backup
```

Backups use AES-256-GCM. The online SQLite snapshot is created in a private temporary directory, encrypted and the temporary plaintext removed. A host administrator still has access while the server runs; use trusted storage and host access controls.

Restore **to a NEW filename**, while the app is stopped:

```sh
npm run restore -- /private/backups/nawlogic-example.nwlbackup ./data/restored.sqlite
```

The command requires the original `BACKUP_KEY`, rejects tampering/wrong keys, checks SQLite integrity/foreign keys, and never overwrites an existing target. It revokes restored sessions and all client links. Preserve the old database and sidecars as a rollback set; point `DATABASE_PATH` to the newly restored file. Do not mix old WAL/SHM files with the new database.

Restore the original `MFA_ENCRYPTION_KEY`, or copy the original MFA key to `./data/restored.sqlite.mfa-key` with owner-only permissions. A database containing active MFA fails startup if the file key is missing. Verify clients, invoice/receipt balances, note PDFs, bank matches and audit before restarting public access. Generate new customer links as needed.

A JSON export contains portable business records and all audit entries, without owner passwords, sessions, MFA secrets or recovery hashes. It is **not** a restore image. Never copy only a live main SQLite file in WAL mode; use the app backup or SQLite online backup API.

## Console account recovery

When password/authenticator/recovery codes or the MFA key are irretrievably lost, an authorized operator with local server access can stop the app and run:

```sh
npm run recover
```

Type the exact owner email when prompted. Recovery generates a new password, disables MFA, deletes recovery codes, revokes sessions and records `local-console` in the audit. It is unavailable through HTTP. Sign in privately, change the generated password and re-enrol MFA. Console/volume access is a privileged capability; restrict it accordingly. If an obsolete MFA key file is invalid, preserve it for investigation, then install a valid new key after recovery before restarting.

## Financial corrections and reconciliation

- Record each actual customer receipt once. Allocate its available funds across invoices for that customer.
- Reverse a mistaken allocation to free those funds. This does not return money at the bank.
- Issue credit/debit notes to correct issued invoice value. Issued originals and notes cannot be edited.
- Record a refund only after returning actual money, then match the bank debit. A refund cannot exceed available funds.
- Void an erroneous receipt only after reversing allocations and resetting bank matches; refunded receipts cannot be voided.
- CSV import uses normalized `date,reference,amount` columns, with optional `description,transaction_id`; dates are `YYYY-MM-DD`, MYR amounts omit grouping commas and use negatives for money out. Preview precedes import. Use a stable transaction ID if the bank provides one. Without IDs, identical normalized rows deduplicate; inspect genuinely identical separate transactions before importing.
- Import/matching does not create additional income. Owner capital and operating expenses may be excluded with a reason; this billing tool is not a general ledger.

See [migration and phase 1 behavior](RELEASE-0.2.md). Audit entries have update/delete guards but are not cryptographically tamper-evident against server administrators. Customer acceptance records an interaction, not independent signer verification. Bearer links should be revoked if leaked.

Payment gateways, bank feeds, outgoing email, uploads, MyInvois and production hosting remain unconnected. Gateway callbacks will require signature verification and idempotency before any future balance changes.
