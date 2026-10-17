# Deployment and operations

## Shape

Use Node.js 24, one app instance and one writable persistent SQLite volume outside the public directory. The same-origin API uses foreign keys, WAL and transactions. Browser assets require no frontend build. Install locked dependencies with `npm ci`. Multiple staff, companies and server replicas are outside this release.

## Production on your own server

This repository includes everything to run Nawlogic on one server with your own domain and HTTPS: `docker-compose.yml` (the app behind [Caddy](https://caddyserver.com/), which gets and renews the Let's Encrypt certificate), `scripts/install.sh` for a fresh server and `scripts/update.sh` for later updates.

**Choosing and paying for the server and the domain is your decision.** Nothing is provisioned from this repository, no hosting provider is recommended and no partnership is implied. The steps below work with any provider that gives you an Ubuntu or Debian virtual server (VPS) with a public IP address.

### What you need

- **A VPS** with Ubuntu 24.04 LTS (or Debian 12/13), 1 vCPU, 1–2 GB RAM and 20 GB disk is enough for one business. A data centre in **Malaysia or Singapore** keeps pages fast for clients in Malaysia. Choose a provider whose terms suit business and personal data under Malaysia's PDPA, and turn on SSH-key login.
- **A domain or sub-domain** for the app, e.g. `billing.yourcompany.com.my` (`.my` names come from MYNIC-accredited registrars). Using a sub-domain of your existing website is fine.
- **A DNS A record** for that name pointing to the server's public IPv4 address (and an AAAA record if the server has IPv6). Create it before the install so the certificate can be issued; DNS changes can take minutes to hours to spread.
- **Ports 22, 80 and 443** open in the provider's firewall. Port 80 is needed for the certificate challenge and redirects to HTTPS.
- **An email address** for certificate notices and one for the owner sign-in.

### One-command install

Sign in to the server with SSH, copy this repository to `/opt/nawlogic` (for example with `git clone <your copy of the repository> /opt/nawlogic`) and run:

```sh
cd /opt/nawlogic
sudo ./scripts/install.sh
```

The script asks for the domain, the certificate email and the owner email (or reads `DOMAIN`, `ACME_EMAIL` and `OWNER_EMAIL` from the environment for an unattended install). It then:

1. installs Docker Engine and Docker Compose from Docker's own apt repository (skipped when already installed);
2. checks what the domain resolves to and warns when the DNS record is missing;
3. writes `/opt/nawlogic/.env` (mode 600, root only) with `NODE_ENV=production`, the HTTPS `APP_URL`, `TRUST_PROXY=1` and **new, independent `BACKUP_KEY` and `MFA_ENCRYPTION_KEY`**. Running it again never replaces existing keys;
4. creates the encrypted backup folder `/opt/nawlogic/backups`;
5. allows SSH, HTTP and HTTPS in `ufw` when it is installed (`ENABLE_UFW=1` also turns ufw on);
6. builds the app image and creates the owner account, printing a generated password once;
7. starts the stack and waits until `https://<domain>/api/health` answers, then prints the next steps.

Copy `.env` into your password manager straight away: **a backup cannot be restored without `BACKUP_KEY`, and authenticator (MFA) secrets cannot be read without `MFA_ENCRYPTION_KEY`.**

### What runs

| Service | Role |
| --- | --- |
| `app` | Nawlogic on port 3000 inside Docker only (not published on the host), read-only file system, no Linux capabilities, health check on `/api/health`, restarted automatically |
| `caddy` | Public ports 80 and 443 (HTTP/3 on 443/udp), automatic HTTPS for `DOMAIN`, compression, passes the real client address so login and link rate limits work (`TRUST_PROXY=1`) |

Data lives in the Docker volume `nawlogic_app-data` (the SQLite database, its WAL files and pre-migration snapshots). Encrypted backups go to the host folder in `BACKUP_HOST_DIR` (default `/opt/nawlogic/backups`): one on every start, then every 24 hours, keeping the last seven. Container logs rotate at 10 MB × 5 files per service.

Useful commands, run in `/opt/nawlogic`:

```sh
sudo docker compose ps                 # status and health
sudo docker compose logs -f app        # app log
sudo docker compose logs caddy         # certificate and proxy log
sudo docker compose exec app node server/cli.mjs backup   # backup now
sudo docker compose restart app
```

Docker publishes ports 80 and 443 directly and bypasses `ufw` rules for them; nothing else is published, so the app and the database are not reachable from the internet. Keep the provider firewall limited to 22, 80 and 443 as well, and consider allowing SSH only from your office IP.

### Backups off the server

Backups on the same server are lost with the server. Copy the encrypted files somewhere else every day. They are AES-256-GCM encrypted, so ordinary cloud storage is acceptable; keep the keys elsewhere (your password manager), never next to the copies.

- With [rclone](https://rclone.org/) to any S3-compatible bucket, Google Drive, OneDrive or similar (configure once with `rclone config`), as a root cron job:

  ```cron
  30 3 * * * rclone copy /opt/nawlogic/backups offsite:nawlogic-backups --max-age 72h
  ```

- Or pull from another computer you control: `rsync -a root@your-server:/opt/nawlogic/backups/ ~/nawlogic-backups/`.

Do a restore drill once after setup and after big changes: restore the newest copy to a new file with `npm run restore` (see below) on a spare machine and check the balances. If the built-in off-site backup (roadmap no. 79) is available and set up in Settings, it can replace this cron job.

To restore on the Docker setup (the app is stopped; the old database is kept in `old/`):

```sh
cd /opt/nawlogic
sudo docker compose stop app
sudo docker compose run --rm --no-deps app node server/cli.mjs restore /app/backups/nawlogic-<date>.nwlbackup /app/data/restored.sqlite
sudo docker compose run --rm --no-deps app sh -c 'cd /app/data && mkdir -p old && mv nawlogic.sqlite* old/ && mv restored.sqlite nawlogic.sqlite'
sudo docker compose up -d
```

A backup copied back from off-site goes into `/opt/nawlogic/backups` first. The same `.env` (keys) must be in place.

### Updates

```sh
cd /opt/nawlogic
sudo ./scripts/update.sh
```

The update script first makes an encrypted backup with the version that is running (and stops if that fails), then runs `git pull --ff-only`, keeps the running image as `nawlogic-invoice:previous`, rebuilds, restarts and waits for the health check. If the new version does not become healthy it prints the rollback commands. Database changes run forward only; each one first saves a private copy of the database next to it (`*.pre-*.sqlite`), and the backup from the first step is in the backup folder. Use `SKIP_PULL=1` when you copied the new code yourself.

### Alternative: systemd and nginx

Without Docker, run Node.js 24 directly behind nginx:

1. Install Node.js 24 (official binaries or your distribution's NodeSource packages), nginx and certbot.
2. Create a system user and folders: `sudo useradd --system --home /opt/nawlogic --shell /usr/sbin/nologin nawlogic`, copy the repository to `/opt/nawlogic`, run `npm ci --omit=dev`, and create `/opt/nawlogic/data` and `/var/backups/nawlogic` owned by `nawlogic` with mode 700.
3. Write `/opt/nawlogic/.env` (owner root, mode 600) with `NODE_ENV=production`, `APP_URL=https://your-domain`, `TRUST_PROXY=1`, `BACKUP_DIRECTORY=/var/backups/nawlogic`, and new `BACKUP_KEY` and `MFA_ENCRYPTION_KEY` values.
4. Create the owner with the same settings the service will use: `sudo bash -c 'set -a; . /opt/nawlogic/.env; set +a; cd /opt/nawlogic; DATABASE_PATH=/opt/nawlogic/data/nawlogic.sqlite setpriv --reuid=nawlogic --regid=nawlogic --init-groups node server/cli.mjs setup'`. Save the printed password.
5. Install `deploy/nawlogic.service` into `/etc/systemd/system/`, then `sudo systemctl daemon-reload && sudo systemctl enable --now nawlogic`. The unit binds to 127.0.0.1:3000 and can only write the data and backup folders.
6. Adapt `deploy/nginx.conf.example` to your domain in `/etc/nginx/sites-available/`, enable it, run `sudo certbot --nginx -d your-domain` and reload nginx. The example overwrites `X-Forwarded-For` with the real client address, which `TRUST_PROXY=1` expects.
7. Allow only 22, 80 and 443 in the firewall, and set up off-server backup copies as above.

## Before real use

1. Run `npm run setup`, save the generated password privately, change it in Settings and enable MFA. Save the ten recovery codes in your password manager.
2. Complete the company registration, business address, contact and bank instructions. Real issuance requires registration, address and at least one contact. Issued documents retain their snapshots.
3. Test PDFs, customer links and payment corrections with disposable data. Review any migrated legacy duplicates and recurring dates.
4. Use a TLS reverse proxy, exact HTTPS `APP_URL`, `NODE_ENV=production` and persistent storage. Production requires HTTPS and Secure cookies.
5. Restrict the Node port to the proxy. Apply expected-host and edge rate limits. Behind a reverse proxy, set `TRUST_PROXY=1` (or the number of proxies) so login and public-link rate limits use each client's address. The proxy must overwrite or append `X-Forwarded-For`, and Node must not be reachable except through the proxy. Without it, all requests through the proxy share one limit.
6. Configure encrypted backups and a separate off-host copy; complete a disposable restore drill. Preserve the MFA key separately from the database.
7. If you are SST-registered, add the SST number and TIN in Settings and set each service's default rate. Review SST/MyInvois obligations with your accountant: the SST summary is a working aid, and credit/debit notes carry no SST breakdown or validated tax submission.

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
| `SMTP_HOST`          | unset                                          | Outgoing mail server; email features stay off when unset        |
| `SMTP_PORT`          | `587`                                          | 587 with STARTTLS (required) or 465 with implicit TLS           |
| `SMTP_USER` / `SMTP_PASS` | unset                                     | SMTP credentials; use an app password, never commit it          |
| `MAIL_FROM`          | unset                                          | Sender, e.g. `Nawlogic Billing <billing@your-domain>`           |
| `MAIL_REPLY_TO`      | unset                                          | Optional reply-to address                                       |
| `TRUST_PROXY`        | unset                                          | Number of reverse proxies that append `X-Forwarded-For` (`true` = 1) |
| `BILLPLZ_API_KEY`    | unset                                          | Billplz secret key; online payment stays off when unset         |
| `BILLPLZ_COLLECTION_ID` | unset                                       | Billplz collection that new bills are created in                |
| `BILLPLZ_X_SIGNATURE_KEY` | unset                                     | Verifies callbacks and redirects; X Signature must be enabled   |
| `BILLPLZ_SANDBOX`    | unset                                          | `true` uses billplz-sandbox.com for testing                     |
| `DOMAIN`             | unset                                          | docker-compose only: the domain Caddy serves; `APP_URL` becomes `https://DOMAIN` |
| `ACME_EMAIL`         | unset                                          | docker-compose only: email for Let's Encrypt certificate notices |
| `BACKUP_HOST_DIR`    | `./backups`                                    | docker-compose only: host folder mounted as the backup directory |
| `PLATFORM_OWNER_WHATSAPP` | unset                                     | Owner's own WhatsApp number for quick invoices (also in Settings) |

Generate each key independently:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store keys in a private environment/secret manager, never Git. Do not casually rotate either encryption key: existing ciphertext needs its original key. If no MFA env key is supplied, preserve the generated `.mfa-key` file with permissions `0600`. Back it up separately and securely. The backup key does not replace the MFA key.

Never commit `.env`, databases, key files, encrypted backups, exports, customer invoices or real bank instructions. No external service credential is required for local billing.

## Docker without Compose

`docker-compose.yml` is the supported production setup (see above). To run the image by hand instead, validate it on your host:

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

Set `NODE_ENV=production` and your real HTTPS `APP_URL` in the private environment. Mount a writable persistent backup directory if backups are enabled. The app runs as the unprivileged `node` user; volume/key permissions must permit that user only. Keep the TLS proxy in front of the loopback-bound port. The image has a health check on `/api/health`.

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

The command requires the original `BACKUP_KEY`, rejects tampering/wrong keys, checks SQLite integrity/foreign keys, and never overwrites an existing target. It revokes restored sessions, all client links and connector tokens, disables workflow rules and marks interrupted AI runs failed. Preserve the old database and sidecars as a rollback set; point `DATABASE_PATH` to the newly restored file. Do not mix old WAL/SHM files with the new database.

Restore the original `MFA_ENCRYPTION_KEY`, or copy the original MFA key to `./data/restored.sqlite.mfa-key` with owner-only permissions. A database containing active MFA fails startup if the file key is missing. Verify clients, invoice/receipt balances, note PDFs, bank matches and audit before restarting public access. Generate new customer links as needed.

A JSON export contains portable business records and all audit entries, without owner passwords, sessions, MFA secrets or recovery hashes. It is **not** a restore image. Never copy only a live main SQLite file in WAL mode; use the app backup or SQLite online backup API.

## Console account recovery

When password/authenticator/recovery codes or the MFA key are irretrievably lost, an authorized operator with local server access can stop the app and run:

```sh
npm run recover
```

Type the exact owner email when prompted. Recovery generates a new password, disables MFA, deletes recovery codes, revokes sessions and connector tokens, disables rules and records `local-console` in the audit. It is unavailable through HTTP. Sign in privately, change the generated password and re-enrol MFA. Console/volume access is a privileged capability; restrict it accordingly. If an obsolete MFA key file is invalid, preserve it for investigation, then install a valid new key after recovery before restarting.

## Financial corrections and reconciliation

- Record each actual customer receipt once. Allocate its available funds across invoices for that customer.
- Reverse a mistaken allocation to free those funds. This does not return money at the bank.
- Issue credit/debit notes to correct issued invoice value. Issued originals and notes cannot be edited.
- Record a refund only after returning actual money, then match the bank debit. A refund cannot exceed available funds.
- Void an erroneous receipt only after reversing allocations and resetting bank matches; refunded receipts cannot be voided.
- CSV import uses normalized `date,reference,amount` columns, with optional `description,transaction_id`; dates are `YYYY-MM-DD`, MYR amounts omit grouping commas and use negatives for money out. Preview precedes import. Use a stable transaction ID if the bank provides one. Without IDs, identical normalized rows deduplicate; inspect genuinely identical separate transactions before importing.
- Import/matching does not create additional income. Owner capital and operating expenses may be excluded with a reason; this billing tool is not a general ledger.

See [migration and phase 1 behavior](RELEASE-0.2.md). Audit entries have update/delete guards and form a SHA-256 hash chain: `npm run audit-verify` (or Settings > Audit trail) detects changed, removed or inserted entries, and a chain head recorded earlier (for example by your accountant each month) also detects a full rewrite. Someone with full server access can still recompute every hash after the last recorded head, so record heads off the server. See [team features](features/team.md). Customer acceptance records an interaction, not independent signer verification. Bearer links should be revoked if leaked.

Online payment works only after you configure your own Billplz account. Billplz must be able to reach `APP_URL/api/payments/billplz/callback` over HTTPS. Each callback and browser return is checked against the X Signature, and the bill is then read back from Billplz before a receipt is recorded, so a forged or replayed notification cannot mark an invoice paid. If an invoice was already settled another way, the online payment is kept as customer funds to allocate or refund. Test the full flow in sandbox mode first.

Bank feeds, uploads and MyInvois remain unconnected. The production hosting kit is included, but the server, domain and DNS are yours to set up; nothing is provisioned from here. Outgoing email works only after you configure your own SMTP account; set up SPF/DKIM for the sending domain so invoices are not marked as spam.

## Optional sales automation / AI

See [AUTOMATION.md](AUTOMATION.md) for the v0.3 sales/PO model, scoped REST/MCP setup, optional AI provider environment, worker lifecycle and restore behavior. The MCP server is a stdio subprocess connecting to this app over authenticated REST, rather than another database writer. The normal app starts its deterministic event worker every 30 seconds; rules remain disabled until configured by the owner.

The built-in assistant requires a selected tool-capable model and server-side provider configuration. Prompts and requested business records go to that provider only after the UI's explicit per-request consent. Test the actual model/provider before real customer use; automated provider tests use controlled test responses. No live model/provider billing or external automation is provisioned by this repository.
