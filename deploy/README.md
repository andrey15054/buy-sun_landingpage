# buysun.kz on a VPS

One small server runs everything. Today it is Hoster.kz (1 CPU, 2 GB memory,
25 GB disk, Ubuntu 26.04); the script was also tested on Ubuntu 24.04 with
1 GB memory:

| Part | What it does |
|---|---|
| Caddy | Serves the site over HTTPS, gets and renews the certificate itself, forwards `/api` to the API |
| `buysun-api` | The forms and anketa server (`server/`), only reachable from the machine itself |
| PostgreSQL | Leads and anketas, local socket only, no password |
| `buysun-update.timer` | Every 5 minutes: if `main` on GitHub has a new commit, builds and switches to it |
| `buysun-backup.timer` | Every night 03:30: database + anketa files, 14 days kept, copied off the server |
| `buysun-restore-test.timer` | 1st of every month: restores the latest backup into a temporary database and checks it |
| `buysun-healthcheck.timer` | Every 5 minutes: site, API, certificate, disk, backups, failed jobs, failed deliveries; emails the client |
| unattended-upgrades | Security updates every day, reboot at 04:30 when the kernel needs it |
| ufw, fail2ban | Only SSH, 80 and 443 are open; 5 wrong SSH logins in 10 minutes block that address for an hour |

Measured on a test machine: about 200 MB of memory in use, everything comes
back by itself after a reboot.

## What is needed before the move

1. **The server**: Ubuntu 24.04 or 26.04, ordered in the client’s name, root SSH access.
2. **GitHub access**: nothing while the repository is public, the server reads
   it over HTTPS. If it becomes private, run the script with
   `REPO_URL=git@github.com:andrey15054/buy-sun_landingpage.git`: it prints a key
   that the owner adds in Settings → Deploy keys (read-only).
3. **Work email** for lead copies and problem alerts, and an SMTP mailbox to send from.
4. **Bitrix24** incoming webhook with the CRM scope (see `server/README.md`).
5. **Off-site backup storage**: any place rclone supports (PS.kz object storage,
   Google Drive, Yandex Disk), set up as an rclone *crypt* remote.

## Setup

```bash
ssh root@<server>
git clone https://github.com/andrey15054/buy-sun_landingpage.git /tmp/buysun   # or copy deploy/setup-server.sh
DOMAIN=buysun.kz bash /tmp/buysun/deploy/setup-server.sh
```

The script can be run again at any time; it only does what is missing. With
a `git@github.com:` address it stops once to show the GitHub key, then
continues on the next run.

Until the pull request is merged into `main` (today `main` is still the
Vercel site), deploy the branch with everything: add
`BRANCH=docs/claude-site-editing` to the command. After the merge switch to
`main`: set `DEPLOY_BRANCH=main` in `/opt/buysun/shared/server.env`; the
next update (within 5 minutes) takes `main`.

### SSH: another port, keys only

Done in steps so access is never lost:

```bash
SSH_PORT=52022 bash /opt/buysun/repo/deploy/setup-server.sh      # 22 and 52022 both open
ssh -p 52022 root@<server>                                         # from your computer: must work
SSH_PORT=52022 SSH_CLOSE_OLD_PORT=1 bash /opt/buysun/repo/deploy/setup-server.sh   # 22 closed
```

For keys only, first `ssh-copy-id -p 52022 root@<server>` from each computer
that needs access, check a login without a password, then run the script with
`SSH_PORT=52022 SSH_KEYS_ONLY=1`. Without a key in `/root/.ssh/authorized_keys`
the script leaves password logins on. If you are locked out anyway, the
hosting control panel has a console (VNC) that does not go through SSH.

Then:

1. Fill in Bitrix24, SMTP and emails in `/opt/buysun/shared/server.env`,
   `systemctl restart buysun-api`.
2. Check the new server before switching the domain:
   `curl -k --resolve buysun.kz:443:<server ip> https://buysun.kz/api/health`.
3. In the PS.kz DNS panel point `buysun.kz` and `www.buysun.kz` (A records) to
   the server. Caddy gets the certificate within a minute after DNS updates.
   The old Vercel site keeps working until then, so there is no downtime.
4. Off-site backups: `sudo -u buysun rclone config` (a crypt remote over the
   storage), set `BACKUP_REMOTE=<remote>:backups` in `server.env`. After the
   first night: `sudo -u buysun /opt/buysun/current/server/scripts/restore-test.sh --remote`.
5. **Outside uptime monitor.** The health check runs on the server and cannot
   report the server itself being off. Create a free monitor at
   uptimerobot.com (HTTP(s), `https://buysun.kz/api/health`, every 5 minutes)
   with alerts to the client’s work email.

## Managers and the cabinet

The cabinet is at `https://buysun.kz/admin/`; every anketa in Bitrix24 has a
link “Открыть и исправить анкету в кабинете”.

The setup script creates the first manager, `buysun@gmail.com` (another one:
`ADMIN_EMAIL=… ADMIN_NAME=…` before `setup-server.sh`). Its temporary password
is made on the server, never stored in the repository (it is public), shown at
the end of the setup and kept in `/opt/buysun/shared/first-manager.txt`; delete
that file after the first login. Add more managers on the server:

```bash
sudo -u buysun /opt/buysun/current/deploy/manager.sh add anna@buysun.kz "Анна Ли"
```

It prints a temporary password; send it to the manager privately. On the
first login the cabinet asks for a new password. Forgotten password:
`manager.sh reset <email>`. The same is in the cabinet, page «Менеджеры» at
the top: any manager can add a colleague, give a new temporary password or
close someone's access (not their own).
Someone left: `manager.sh disable <email>`. Everyone: `manager.sh list`.

**File for a partner.** On every anketa page, section “Файл для партнёра”: the
manager picks the partner’s logo, header and contacts, sees a preview and
downloads a PDF named `Name_Surname_CV.pdf`. There is no BUY SUN in it (not
in the text, the font name or the file name), and the BUY SUN manager’s name
is left out. A template is saved per partner (TAYGA GRUP, PATIKA, …), shared by
all managers: the list «Шаблон» picks one, «+ Новый партнёр» adds another. The
browser remembers the last partner chosen. Templates are part of the nightly
database backup.
The button «Анкета TAYGA GRUP (Word)» fills TAYGA's own CV form
(`src/admin/partnerForms/tayga.docx`) with the anketa and the photo; their
layout stays as is, and the file can still be edited in Word.

**For Canva.** The “Для Canva” button next to “Скачать PDF” downloads
`Name_Surname_Canva.pdf`: white pages, every line real text, photos as separate
pictures, no logo and no manager name. In Canva: Create a design → Import file;
the text can then be edited. Both partner and Canva files are made from the
anketa as it is on the screen.

## Google Drive for anketa copies

Anketas are copied to the agency's Google Drive: one folder per anketa with
the PDF and photos. Two parts.

**1. The site's key from Google (the developer, once, ~10 minutes).** In
[Google Cloud Console](https://console.cloud.google.com/), with any Google
account the developer keeps:

1. New project «BUY SUN сайт».
2. APIs & Services → Library → **Google Drive API** → Enable.
3. Google Auth Platform (OAuth consent screen): app name «BUY SUN», support
   email, audience **External**; Data access → add the scope
   `https://www.googleapis.com/auth/drive.file` (non-sensitive, no Google
   review needed); Audience → **Publish app** («In production»). In
   «Testing» Google cuts the access off after 7 days.
4. Clients → Create client → **Web application**; Authorized redirect URI
   `https://buysun.kz/api/admin/google/callback`.
5. Put the Client ID and Client secret into `/opt/buysun/shared/server.env`
   (`GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`), then
   `sudo systemctl restart buysun-api`.

**2. The agency's Drive (Ahmed, once, 1 minute).** Cabinet → «Google Диск» at
the top (`https://buysun.kz/admin/#/google`) → «Подключить Google Диск» →
the Google account for the anketas → «Разрешить». No password is shared; the
site sees only the files it made. All anketas already on the site are copied
at once, new ones right after they are sent. «Отключить» there gives the
access back; the copies stay in Drive.

## Everyday

- **Updating the site**: merge into `main` on GitHub. Within 5 minutes the
  server prepares the new version (code, server packages, built site) in its
  own folder next to the running one and switches to it in one step; database
  migrations run automatically. A failed update leaves the running version
  untouched and is retried in 5 minutes; if the new API does not start, the
  previous version is switched back. Packages are downloaded only when
  `package-lock.json` changes. Log: `journalctl -u buysun-update`.
  Force: `sudo -u buysun /opt/buysun/current/deploy/update.sh --force`.
- **Going back**: the last 5 builds stay in `/opt/buysun/releases`; the quickest
  way back is to revert the commit on GitHub.
- **Logs**: `journalctl -u buysun-api -f`, site requests in `/var/log/caddy/buysun.log`.
- **Caddyfile changes** are not deployed by the auto-update: after a change in
  `deploy/Caddyfile`, run the `sed … > /etc/caddy/Caddyfile` line from
  `setup-server.sh`, then `caddy validate --config /etc/caddy/Caddyfile` and
  `systemctl reload caddy`. (Five anketa photos raised the upload limit to 42 MB.)
- **Restore**: `server/README.md`, section Backups.

## Files

| Path | What |
|---|---|
| `/opt/buysun/repo` | Git checkout the updates are fetched into |
| `/opt/buysun/current` | → the running version in `/opt/buysun/releases/`: code, server packages, the site Caddy serves (`site/`) |
| `/opt/buysun/cache` | Installed packages per `package-lock.json`, shared by versions as hard links |
| `/opt/buysun/shared/server.env` | Settings and secrets, readable only by `buysun` |
| `/var/lib/buysun/uploads` | Anketa PDFs and photos, readable only by `buysun`, never served |
| `/var/backups/buysun` | Local backups |
