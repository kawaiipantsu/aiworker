# Install AI Worker

These commands target a **fresh Debian 13 host with systemd**, PHP 8.4, Node.js
22+, and root access. Use `/opt/aiworker/app` for the checkout: the included
systemd and web-server examples use that path. If you choose another path,
update every template before installing it. This is a native host installation;
Docker is not required. Project workloads can execute arbitrary code, so use a
dedicated host and give dashboard access only to trusted operators.

You need a hostname pointing to the server (or a local hosts-file entry), HTTPS,
and access to at least one supported provider. Replace `aiworker.example.com`
in the commands with your hostname. Examples contain only generic service-account
names and placeholders; no existing deployment credentials are included.

Run the following sections in order. Keep the root shell open for the commands.

## 1. Packages and source

```sh
sudo -i
apt-get update
apt-get install -y git ca-certificates curl openssl sudo python3 build-essential \
  apache2 php8.4-cli php8.4-fpm php8.4-mysql php8.4-redis php8.4-curl \
  php8.4-zip php8.4-mbstring php8.4-xml php-tcpdf \
  mariadb-server mariadb-client redis-server beanstalkd nodejs npm

node --version
php --version
install -d -m 755 /opt/aiworker
git clone https://github.com/kawaiipantsu/aiworker.git /opt/aiworker/app
cd /opt/aiworker/app
npm ci --prefix worker --omit=dev
```

PHP must provide PDO MySQL, Redis, cURL, ZIP, mbstring, OpenSSL, and Argon2id.
`php-tcpdf` supplies PDF exports; Python handles safe workspace deletion. There
is no Composer dependency or frontend build. Install additional project tools
(Python venvs, language SDKs, database clients, etc.) as your workloads need them.

## 2. Accounts and private directories

```sh
groupadd --system aiworker-app
groupadd --system aiworker-credentials
useradd --system --user-group --create-home --home-dir /var/lib/aiworker --shell /bin/bash aiworker
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aiworker-web
useradd --system --user-group --create-home --home-dir /var/lib/aiworker-ideas --shell /usr/sbin/nologin aiworker-ideas
usermod -aG aiworker-app aiworker
usermod -aG aiworker-app,aiworker-credentials aiworker-web
usermod -aG aiworker-app,aiworker-credentials aiworker-ideas

install -d -o root -g aiworker-app -m 750 etc
install -d -o root -g root -m 755 docs
install -d -o root -g root -m 711 var
install -d -o aiworker -g aiworker -m 700 var/uploads
install -d -o aiworker-web -g aiworker-web -m 700 var/php-uploads
install -d -o root -g root -m 700 var/backups
install -d -o aiworker -g aiworker -m 2770 /srv/projects
chmod 700 /var/lib/aiworker /var/lib/aiworker-ideas
install -d -o aiworker -g aiworker -m 700 /var/lib/aiworker/.codex /var/lib/aiworker/.claude
install -d -o root -g root -m 755 /opt/aiworker/bin
ln -s /opt/aiworker/app/contrib/workload.php /opt/aiworker/bin/workload
chmod 755 contrib/workload.php
```

Keep application code root-owned. The web account must not write to source code
or read provider logins. The worker must not belong to `aiworker-credentials`:
that group can read the separate idea-generator encryption key.

## 3. Local services and database bootstrap

The supplied configuration uses MariaDB on local TCP port 3306, Beanstalkd on
127.0.0.1:11300, and Redis on 127.0.0.1:6379, database 5. The PHP session code
also uses that fixed local Redis address/database. Keep these services private.
On a fresh Debian installation, leave MariaDB/Redis bound to loopback and Redis
protected mode enabled. Explicitly bind Beanstalkd to loopback:

```sh
install -d /etc/systemd/system/beanstalkd.service.d
cat > /etc/systemd/system/beanstalkd.service.d/local.conf <<'CONFIG'
[Service]
ExecStart=
ExecStart=/usr/bin/beanstalkd -l 127.0.0.1 -p 11300
CONFIG
cat > /etc/mysql/mariadb.conf.d/60-aiworker.cnf <<'CONFIG'
[mysqld]
max_allowed_packet = 64M
CONFIG
systemctl daemon-reload
systemctl enable --now mariadb redis-server beanstalkd
systemctl restart mariadb
systemctl restart beanstalkd
ss -ltn | grep -E ':(3306|6379|11300)\b'

python3 contrib/bootstrap-local.py --url https://aiworker.example.com
```

The script uses MariaDB root's local socket authentication. It creates:

- Database `aiworker` and a database-only account with a random 256-bit password.
- `etc/config.json` with that password, mode 0640, root:`aiworker-app`.
- `etc/secrets.key`, 32 random binary bytes, mode 0640, root:`aiworker-credentials`.
- Every table in `app/schema.sql` and the application defaults via `contrib/install.php`.
- Provider-state rows, an unconfigured OpenAI connection, concurrency/retry/model
  settings, and an administrator with a random 192-bit password hashed with Argon2id.
- `docs/ADMIN_CREDS.md`, root-owned and mode 0600, containing the new login.

Read that file **only in your private terminal**, sign in, and change the password
under **Account**. The password is never printed by bootstrap. Treat the file as
a secret even after rotation. No demo jobs, emails, webhooks, provider tokens, or
existing users are imported. Create projects through the dashboard after setup.

Bootstrap refuses existing private files, databases, or database accounts. It is
not an upgrade/reset command. If it fails partway, retain its private files and
repair the reported local service/permission problem; do not regenerate an
existing encryption key. After database access works, finish or reapply the
schema/default seed with:

```sh
php contrib/install.php
```

The seed is safe to repeat: existing settings and the administrator password/file
are preserved. A pre-existing credential file without a matching admin row is
also preserved, and seeding fails instead of overwriting it. For a partial SQL
provisioning failure, inspect the database/account locally and complete the
missing objects using the password already saved in the private config.

### Existing / external MariaDB instead

Skip `bootstrap-local.py`. Ask your database administrator to create an empty
UTF-8 database and a unique account restricted to this app's database and host.
Then create the private config and key:

```sh
install -o root -g aiworker-app -m 640 etc/config.example.json etc/config.json
sudoedit etc/config.json
# Set db.host, db.user, db.password, db.database and your public HTTPS url.
# Keep the documented local Redis and queue settings for this installation.
python3 - <<'PY'
import grp, os, secrets
fd = os.open('etc/secrets.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'wb') as handle:
    handle.write(secrets.token_bytes(32))
    os.fchown(handle.fileno(), 0, grp.getgrnam('aiworker-credentials').gr_gid)
    os.fchmod(handle.fileno(), 0o640)
PY
php contrib/install.php
```

Do not seed from a production SQL dump: backups contain credentials and private
workload data. The committed `app/schema.sql` contains definitions only.

## 4. Provider CLIs and authentication

Install both CLIs into a shared, root-owned prefix; authenticate only providers
you intend to use. The adapters were developed with Codex 0.154.0 and Claude Code
2.1.269. Check flags and account model availability when upgrading.

```sh
npm install --global --prefix /opt/aiworker @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.269
/opt/aiworker/bin/codex --version
/opt/aiworker/bin/claude --version

sudo -u aiworker -H /opt/aiworker/bin/codex login --device-auth
sudo -u aiworker -H /opt/aiworker/bin/claude auth login
```

Complete the provider's login instructions in your private terminal/browser.
Provider authentication lives in the worker home, outside the repository.
Codex's npm distribution should be installed as a complete package; do not copy
only an executable and omit its companion binaries. See the official
[Codex CLI installation](https://learn.chatgpt.com/docs/codex/cli),
[Codex authentication](https://learn.chatgpt.com/docs/auth), and
[Claude Code setup](https://code.claude.com/docs/en/setup).

For API-key authentication, use the private `etc/worker.env` template for the
provider environment variables, mode 0600, and restart the worker after changes:

```sh
install -o root -g root -m 600 etc/worker.env.example etc/worker.env
sudoedit etc/worker.env
```

Claude can use `ANTHROPIC_API_KEY`. For Codex API-key login, its CLI reads a key
from stdin; perform this interactively as the worker without putting the key in
shell history or command arguments:

```sh
sudo -u aiworker -H bash -c 'read -rsp "OpenAI API key: " aiworker_api_key; printf "\n"; printf "%s" "$aiworker_api_key" | /opt/aiworker/bin/codex login --with-api-key; unset aiworker_api_key'
```

These worker logins are separate from **Administration → OpenAI idea generator**.
Configure that optional connection in the dashboard after first login and use
**Test connection**. The idea generator requires access to the exact model
configured in its code (`gpt-5.6-terra`); an unavailable model is reported as an
error. The seed's model catalog does not grant access to any provider model.

## 5. PHP-FPM and HTTPS

```sh
install -m 644 etc/php-fpm.conf.example /etc/php/8.4/fpm/pool.d/aiworker.conf
a2enmod proxy proxy_fcgi setenvif rewrite headers ssl
php-fpm8.4 -t
systemctl enable --now php8.4-fpm apache2
systemctl restart php8.4-fpm
```

Choose **one** Apache configuration below. Apache's document root must be only
`/opt/aiworker/app/html`; never serve the repository root. The examples deny the
parent directory, allow only the public directory, and route the two PHP entry
points to the restricted FPM pool. The application always sets Secure session
cookies, so browser access must use HTTPS.

### Option A: direct HTTPS with a self-signed certificate

Set your hostname in all three places: bootstrap's URL, the certificate command,
and Apache's ServerName. The certificate includes a DNS Subject Alternative Name.

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -noenc -days 365 \
  -keyout /etc/ssl/private/aiworker.key \
  -out /etc/ssl/certs/aiworker.crt \
  -subj '/CN=aiworker.example.com' \
  -addext 'subjectAltName=DNS:aiworker.example.com'
chmod 600 /etc/ssl/private/aiworker.key
chmod 644 /etc/ssl/certs/aiworker.crt
install -m 644 etc/apache-https.conf.example /etc/apache2/sites-available/aiworker.conf
sed -i 's/aiworker\.example\.com/aiworker.example.com/g' /etc/apache2/sites-available/aiworker.conf
a2ensite aiworker
apache2ctl configtest
systemctl reload apache2
```

In the `sed` replacement (right-hand hostname), use your real hostname. If using
a local hosts file, map that hostname to the server's IP on your client machine.
Trust the self-signed certificate on your own clients after verifying its
fingerprint over a trusted channel. Browsers warn until you trust it. For a
public deployment, use a certificate from a trusted CA and update the two TLS
file paths. Keep private keys out of the repository and backups you publish.

### Option B: upstream TLS proxy

Use this origin template instead of Option A. It listens only on loopback, so
it assumes the upstream proxy runs on the same host:

```sh
install -m 644 etc/apache-proxy.conf.example /etc/apache2/sites-available/aiworker.conf
sed -i 's/aiworker\.example\.com/aiworker.example.com/g' /etc/apache2/sites-available/aiworker.conf
a2ensite aiworker
apache2ctl configtest
systemctl reload apache2
```

Configure your existing TLS proxy to preserve the Host header and route the
public HTTPS hostname to `http://127.0.0.1:8080`. An Nginx server block can use:

```nginx
server {
    listen 443 ssl;
    server_name aiworker.example.com;
    ssl_certificate /etc/ssl/certs/aiworker.crt;
    ssl_certificate_key /etc/ssl/private/aiworker.key;
    client_max_body_size 34m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 65s;
    }
}
```

Use the certificate command from Option A if you want a self-signed proxy
certificate. Nginx is optional (`apt-get install nginx`); when it owns port 443,
remove Apache's `Listen 443` lines from `/etc/apache2/ports.conf` and avoid any
Apache 443 vhosts. Likewise, keep default Apache/Nginx port 80 listeners from
conflicting. Validate both configurations before restarting either service.

For a proxy on another machine, change both loopback addresses in the Apache
origin template to the server's private interface, route the proxy there, and
restrict origin port 8080 to the proxy IP using your firewall. Do not expose the
plain HTTP origin publicly. Set `RemoteIPHeader X-Forwarded-For` and
`RemoteIPTrustedProxy <your-proxy-IP>` with Apache's `remoteip` module only for
that known proxy; otherwise audit/rate-limiting sees the proxy's address.
The application does not use forwarded headers to disable Secure cookies.

## 6. Background services

```sh
cd /opt/aiworker/app
install -m 644 contrib/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aiworker.service aiworker-ideas.service
systemctl enable --now aiworker-retention.timer aiworker-backup.timer
systemctl is-active aiworker aiworker-ideas
php contrib/status.php
```

No interactive login session or user lingering is required. The retention timer
handles explicit deletion requests; automatic cancellation cleanup remains off
until an administrator enables it. The backup timer writes private database
snapshots daily. It does not back up project files or provider homes.

## 7. Verify and populate

Open `https://aiworker.example.com`, sign in using your privately saved credentials,
and change the password under **Account**. In **Administration**, review model
choices and provider concurrency, create any additional operator accounts, and
optionally configure OpenAI ideas or Discord webhooks. Then create a small project
using [HOWTOUSE.md](HOWTOUSE.md). This populates jobs through the normal application
workflow; seeding does not launch billable workloads.

Check services and logs locally (logs may contain private workload content):

```sh
systemctl status aiworker aiworker-ideas php8.4-fpm apache2 --no-pager
journalctl -u aiworker -u aiworker-ideas -n 50 --no-pager
php contrib/status.php
php contrib/project-retention.php
```

Verify `/etc/config.json`, `/docs/ADMIN_CREDS.md`, `/.git/config`, and
`/worker/service.mjs` return 403/404 on the public origin. Only `html/` is public.
For offline unit checks, install dev dependencies and run:

```sh
npm ci --prefix worker
npm test --prefix worker
php tests/zip-url.php
```

The unit suite generates its own encryption fixtures; it needs no real provider
credentials. Browser/lifecycle tests mutate data and some consume provider quota;
run them only on an isolated test deployment. Set `AIWORKER_TEST_URL` for those
tests and install Playwright's Chromium before using them. Some scenarios depend
on the private fixtures created by earlier integration tests.

## Maintenance and recovery

```sh
# Preserve existing accounts/settings while applying schema/defaults:
php contrib/install.php
# Explicit password reset; saves new credentials privately and revokes sessions:
php contrib/reset-password.php admin
# Private DB backup:
node contrib/backup.mjs
```

Back up `etc/secrets.key` securely and separately, plus `/srv/projects` and the
provider homes. Without the same key, a restored database cannot decrypt saved
idea-generator credentials. Never commit runtime data, SQL dumps, screenshots of
accounts, provider login files, private configuration, or `docs/ADMIN_CREDS.md`.
`.gitignore` excludes these; it cannot protect files you force-add.

If login loops, check HTTPS and Redis. If jobs remain queued, check provider
logins, dispatch pause, service health, and account limits. If PDF export fails,
check `php-tcpdf` and the FPM `open_basedir` paths. See
[OPERATIONS.md](docs/OPERATIONS.md) for backup/restore, retries, upgrades, and
[SECURITY.md](docs/SECURITY.md) for execution boundaries.

## Optional full root access for workloads

To grant every workload running as `aiworker` passwordless sudo for any command,
install the supplied sudoers rule. The service continues to run as `aiworker`,
preserving its home directory and provider authentication:

```bash
visudo -cf contrib/sudoers/aiworker-full-access
install -o root -g root -m 0440 contrib/sudoers/aiworker-full-access /etc/sudoers.d/aiworker-full-access
visudo -c
sudo -u aiworker sudo -n id
```

For projects under an existing `/srv/www/vhosts-external` directory, grant direct
write access and allow the retention service to clean up that base:

```bash
usermod -aG www-data aiworker
setfacl -m u:aiworker:rwx /srv/www/vhosts-external
mkdir -p /etc/systemd/system/aiworker-retention.service.d
cat > /etc/systemd/system/aiworker-retention.service.d/workspaces.conf <<'EOF'
[Service]
ReadWritePaths=/srv/www/vhosts-external
EOF
systemctl daemon-reload
systemctl restart aiworker
```

Restart while the worker is idle. These commands grant access to the base;
they do not recursively change ownership or permissions of existing websites.

### Daily suggestions upgrade

Apply `app/suggestions.sql` to an existing database (the installer also applies it). Install the daily line from `contrib/aiworker.cron.example` in `/etc/cron.d/aiworker-suggestions`, substituting the actual application path. Use owner root and mode 0644 for the cron file. The cron daemon must use Europe/Copenhagen local time for 08:00 scheduling. The script runs as aiworker, enqueues the configured number of ideas, and prevents duplicate daily slots. It requires an active administrator and a connected OpenAI account; the idea service processes queued entries. Restart `aiworker-ideas.service` after upgrading to load editable generation-prompt support. No workload starts until an operator picks and creates a suggestion.
