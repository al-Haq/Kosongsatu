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

The update script first makes an encrypted backup with the version that is running (and stops if that fails), then runs `git pull --ff-only`, keeps the running image as `nawlogic-invoice:<project>-previous` (for the first install, `nawlogic-invoice:nawlogic-previous`), rebuilds, restarts and waits for the health check. If the new version does not become healthy it prints the rollback commands. Database changes run forward only; each one first saves a private copy of the database next to it (`*.pre-*.sqlite`, readable only by the app; because they are not encrypted, a successful upgrade deletes copies older than 30 days, always keeping the newest 3), and the backup from the first step is in the backup folder. Use `SKIP_PULL=1` when you copied the new code yourself.

### Alternative: systemd and nginx

Without Docker, run Node.js 24 directly behind nginx:

1. Install Node.js 24 (official binaries or your distribution's NodeSource packages), nginx and certbot.
2. Create a system user and folders: `sudo useradd --system --home /opt/nawlogic --shell /usr/sbin/nologin nawlogic`, copy the repository to `/opt/nawlogic`, run `npm ci --omit=dev`, and create `/opt/nawlogic/data` and `/var/backups/nawlogic` owned by `nawlogic` with mode 700.
3. Write `/opt/nawlogic/.env` (owner root, mode 600) with `NODE_ENV=production`, `APP_URL=https://your-domain`, `TRUST_PROXY=1`, `BACKUP_DIRECTORY=/var/backups/nawlogic`, and new `BACKUP_KEY` and `MFA_ENCRYPTION_KEY` values.
4. Create the owner with the same settings the service will use: `sudo bash -c 'set -a; . /opt/nawlogic/.env; set +a; cd /opt/nawlogic; DATABASE_PATH=/opt/nawlogic/data/nawlogic.sqlite setpriv --reuid=nawlogic --regid=nawlogic --init-groups node server/cli.mjs setup'`. Save the printed password.
5. Install `deploy/nawlogic.service` into `/etc/systemd/system/`, then `sudo systemctl daemon-reload && sudo systemctl enable --now nawlogic`. The unit binds to 127.0.0.1:3000 and can only write the data and backup folders.
6. Adapt `deploy/nginx.conf.example` to your domain in `/etc/nginx/sites-available/`, enable it, run `sudo certbot --nginx -d your-domain` and reload nginx. The example overwrites `X-Forwarded-For` with the real client address, which `TRUST_PROXY=1` expects.
7. Allow only 22, 80 and 443 in the firewall, and set up off-server backup copies as above.

## Cloudflare in front

Cloudflare Pages and Workers cannot host this app: it is a Node.js server with a SQLite file, uploaded files on disk and background jobs, none of which exist on Workers. Cloudflare Containers run Docker images, but their disk is not persistent, so the database would be lost on every restart. What works well is your own small server (the setup above) with Cloudflare in front of it:

- **Cloudflare Tunnel** (recommended). A small `cloudflared` container on your server opens an outbound connection to Cloudflare. Cloudflare serves HTTPS for your domain and forwards visitors through the tunnel. Ports 80 and 443 stay closed on the server, no certificate is issued locally, and Cloudflare's DDoS protection and firewall apply. The free plan is enough.
- **Cloudflare R2** as the off-site backup bucket (S3-compatible, no egress fees).

### Tunnel setup

1. Add your domain to Cloudflare and move its nameservers, or use a sub-domain of a zone that is already on Cloudflare. Nothing else on the domain changes.
2. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, give it a name (for example `nawlogic`) and copy the **token** (the long string after `--token` in the install command Cloudflare shows). Treat it like a password.
3. Under **Public hostname** add your name, for example `billing.example.com`, with **Service** type `HTTP` and URL `app:3000` (the app container as seen by cloudflared). Cloudflare creates the DNS record for it.
4. On the server, run the installer with the token (or run it without and paste the token when asked):

   ```sh
   cd /opt/nawlogic
   sudo CLOUDFLARE_TUNNEL_TOKEN='<token>' ./scripts/install.sh
   ```

   The installer then asks no certificate email and skips the DNS check, opens only SSH in `ufw`, saves the token in `/opt/nawlogic/.env.cloudflare` (root only; the app container never sees it) and sets `COMPOSE_FILE` in `.env` so every `docker compose` command, `scripts/update.sh` included, uses `deploy/docker-compose.cloudflare.yml`: the `cloudflared` service runs instead of Caddy.
5. In Cloudflare **SSL/TLS → Edge Certificates** turn on **Always Use HTTPS**. The SSL mode setting does not matter for a tunnel; traffic to the server travels inside the tunnel.
6. Open `https://billing.example.com/api/health`, then sign in.

Good to know:

- `TRUST_PROXY=1` stays correct: cloudflared sets `X-Forwarded-For` to the visitor's address, so login and link rate limits see real addresses. Do not put another proxy between cloudflared and the app.
- Leave the hostname **proxied** (it is, for tunnels). Do not put Cloudflare Access in front of the whole hostname: clients open private links and the portal without a Cloudflare login.
- Email still goes out from the server over SMTP; Cloudflare is not involved.
- `sudo docker compose logs cloudflared` shows the tunnel; `sudo docker compose restart cloudflared` reconnects it. Rotating the token: paste the new one into `/opt/nawlogic/.env.cloudflare` and restart that service.
- To go back to Caddy later, run the installer again and answer `none` at the token question (or `CLOUDFLARE_TUNNEL_TOKEN=none` unattended). The installer stops the tunnel container; the DNS record must then be an A record to the server and ports 80 and 443 must be open. Switching the other way stops Caddy, so nothing keeps answering on 80 and 443 behind Cloudflare's back.

### Backups to Cloudflare R2

In Cloudflare **R2** create a private bucket (for example `nawlogic-backups`) and an **R2 API token** with *Object Read & Write* limited to that bucket; note your **account ID**. In the app, under **Settings → Integration keys** (off-site backup), enter endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`, the bucket name, and the token's access key ID and secret. Click **Test connection**. From then on every encrypted backup is uploaded as well; the keys that decrypt it stay in your password manager, never in R2. The same values work as server environment variables (see [docs/features/team.md](features/team.md)).

### Proxied DNS without a tunnel

Keeping the Caddy setup and only switching the A record to Cloudflare's proxy also works, but needs two more steps: Caddy must be told to trust Cloudflare's address ranges (`trusted_proxies` in the Caddyfile), and `.env` needs `TRUST_PROXY=2`. Without both, every visitor appears to come from Cloudflare and the login rate limit locks everyone out together. The tunnel avoids all of this and keeps the ports closed, so prefer it.

## Several companies on one server

One Nawlogic install is one company: one database with its clients, documents and payments, one owner and team. Accounts inside an install share that company's data (roles limit what they may do, not what they see), and each client sees only their own documents through their private link or portal login. For a second company with completely separate data, add a second install on the same server. The installs share nothing but the machine: each has its own folder, Docker Compose project, data volume, encryption keys, backup folder, owner login and domain.

The first install may use Caddy or a tunnel. Every further company runs behind its own **Cloudflare Tunnel**, because ports 80 and 443 can belong to one install only; the installer refuses a second Caddy install on the same server.

1. In Cloudflare **Zero Trust → Networks → Tunnels** create a tunnel for the company (for example `nawlogic-acme`), add its **Public hostname** (for example `acme.example.com`) with service `HTTP` and URL `app:3000`, and copy the token.
2. On the server:

   ```sh
   sudo /opt/nawlogic/scripts/companies.sh add acme
   ```

   This clones the code into `/opt/nawlogic-acme` and runs the installer there. The installer asks for the company's domain, the tunnel token and the owner's sign-in email, writes a new `.env` with new keys, builds the app, creates the owner and prints the password once. The Compose project is `nawlogic-acme` (from the folder name), so its containers, data volume and image tag never touch the first install.
3. Sign in at the new domain, change the password, turn on MFA and fill in that company's Settings.

Day to day:

- `sudo /opt/nawlogic/scripts/companies.sh list` shows every install with its project, domain, front (Caddy or tunnel) and container status.
- `sudo /opt/nawlogic/scripts/companies.sh update` updates every install in turn, each with its own backup first; `update acme` updates one. `scripts/update.sh` inside a folder still updates that install alone.
- Backups: each install writes to its own `backups` folder with its own key. For off-site copies give each company its own R2 bucket, or at least its own prefix, in that company's Settings → Integration keys.
- Removing a company: `cd /opt/nawlogic-acme && sudo docker compose down` stops it and keeps its data volume; `sudo docker compose down -v` deletes the data as well, so take a final backup first.
- Resources: each install is one Node.js container (about 150 MB of memory at rest) plus a small `cloudflared`; a 4 GB server runs several comfortably.

An install made before this option has no `COMPOSE_PROJECT_NAME` in its `.env`. It keeps the project name `nawlogic` that `docker-compose.yml` declares, and with it its containers and data; the next `scripts/update.sh` adopts its existing image under the new tag before taking the backup.

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
| `PAYMENT_PROVIDER`   | unset                                          | Fixes the online payment provider (`billplz`, `toyyibpay`, `stripe`, `ipay88` or `off`); otherwise chosen in Settings |
| `TOYYIBPAY_SECRET_KEY` / `TOYYIBPAY_CATEGORY_CODE` / `TOYYIBPAY_SANDBOX` | unset | ToyyibPay keys (see [payments](features/payments.md)) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | unset                 | Stripe Checkout keys; webhook at `/api/hooks/payments/stripe` |
| `IPAY88_MERCHANT_CODE` / `IPAY88_MERCHANT_KEY` / `IPAY88_SANDBOX` | unset | iPay88 keys |

All payment keys can instead be entered in Settings > Online payments; a server value wins.

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

## Adding a user from the console

Users are normally added from **Team → Invite user**, and choose their own password from the link. When that is not practical, an operator with server access can add an active user directly. With Docker (the installer's setup), run it in the app container from the install folder:

```sh
cd /opt/nawlogic
sudo docker compose exec app node server/cli.mjs add-user person@example.com owner "Their Name"
```

Without Docker, run `npm run add-user -- person@example.com owner "Their Name"`. The role is `owner`, `staff` (the default) or `accountant`, and the name is optional.

- A strong password is generated and **shown once**. Pass it to the person privately. They sign in, change it, and enable MFA.
- To set the password yourself instead, add `-e ADMIN_PASSWORD='…'` after `exec`. It is never displayed, but it stays in the shell history.
- An existing email, an unknown role or a password under 12 characters is refused, and nothing is changed.
- The audit records `user.created` with the actor `local-console`.

To change someone's sign-in email (the password, MFA and role stay), an owner uses **Team → Edit**. From the console, which also works for your own account:

```sh
cd /opt/nawlogic
sudo docker compose exec app node server/cli.mjs set-email old@example.com new@example.com
```

The audit records `user.email_changed`.

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
