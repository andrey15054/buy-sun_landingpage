#!/usr/bin/env bash
# One-time setup of a fresh PS.kz VPS (Ubuntu 24.04) for buysun.kz.
# Safe to run again: every step checks what is already done.
#
#   sudo DOMAIN=buysun.kz bash setup-server.sh
#
# Settings (environment variables):
#   DOMAIN      site address, default buysun.kz
#   REPO_URL    GitHub repository, default https://github.com/idrisqtt/buy-sun_landingpage.git
#               (public: no key needed; a git@github.com:... address makes a deploy key)
#   BRANCH      branch to deploy, default main
#   SKIP_SWAP=1 do not create a swap file (only for test containers)
#   SSH_PORT    move SSH to this port, in two runs so access is never lost:
#               SSH_PORT=52022 adds the port next to the current one; after a
#               login on it works, SSH_PORT=52022 SSH_CLOSE_OLD_PORT=1 closes the old one
#   SSH_KEYS_ONLY=1  no password logins (only when root already has a key)
#   ADMIN_EMAIL, ADMIN_NAME  the first manager of the cabinet (default buysun@gmail.com)
set -euo pipefail

DOMAIN="${DOMAIN:-buysun.kz}"
REPO_URL="${REPO_URL:-https://github.com/idrisqtt/buy-sun_landingpage.git}"
BRANCH="${BRANCH:-main}"
ADMIN_EMAIL="${ADMIN_EMAIL:-buysun@gmail.com}"
ADMIN_NAME="${ADMIN_NAME:-BUY SUN}"
NODE_VERSION="24.22.1"
APP_USER=buysun
APP_DIR=/opt/buysun
DATA_DIR=/var/lib/buysun
BACKUP_DIR=/var/backups/buysun

step() { echo; echo "==> $*"; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "WARNING: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}"

step "Time zone Asia/Almaty (backups at 03:30 local time)"
timedatectl set-timezone Asia/Almaty 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Almaty /etc/localtime

step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg xz-utils sudo ufw \
  postgresql postgresql-client unattended-upgrades rclone rsync \
  debian-keyring debian-archive-keyring apt-transport-https

step "Swap 1 GB (the server has 1 GB of memory; building the site needs more)"
if [ "${SKIP_SWAP:-}" != "1" ] && ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Node.js $NODE_VERSION (official build, checksum verified)"
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  arch="$(dpkg --print-architecture)"; [ "$arch" = "amd64" ] && arch=x64
  name="node-v$NODE_VERSION-linux-$arch"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" -o "$tmp/$name.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum --check --quiet)
  rm -rf "/usr/local/lib/$name"
  tar -xJf "$tmp/$name.tar.xz" -C /usr/local/lib
  for bin in node npm npx; do ln -sfn "/usr/local/lib/$name/bin/$bin" "/usr/local/bin/$bin"; done
  rm -rf "$tmp"
fi
node --version

step "Caddy web server (official repository; HTTPS certificates are automatic)"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

step "Automatic security updates (with a night reboot when the kernel needs it)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52buysun-unattended <<'EOF'
Unattended-Upgrade::Origins-Pattern {
        "origin=cloudsmith/caddy/stable";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

step "Logs: keep at most 200 MB"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/buysun.conf
systemctl restart systemd-journald

step "User $APP_USER and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /bin/bash "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR" "$APP_DIR/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/shared" "$DATA_DIR" "$DATA_DIR/uploads" "$BACKUP_DIR"
# The update job may restart the API and nothing else
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart buysun-api.service" > /etc/sudoers.d/buysun
chmod 440 /etc/sudoers.d/buysun
visudo -cf /etc/sudoers.d/buysun >/dev/null

step "Database (PostgreSQL, local socket, no password)"
systemctl enable --now postgresql >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE $APP_USER LOGIN CREATEDB"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$APP_USER'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE DATABASE $APP_USER OWNER $APP_USER"

step "Code from GitHub"
if [ ! -d "$APP_DIR/repo/.git" ]; then
  if [[ "$REPO_URL" == git@* ]]; then
    key="/home/$APP_USER/.ssh/id_ed25519"
    if [ ! -f "$key" ]; then
      as_app mkdir -p -m 700 "/home/$APP_USER/.ssh"
      as_app ssh-keygen -q -t ed25519 -N '' -C "buysun-server" -f "$key"
    fi
    as_app sh -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null"
    if ! as_app git ls-remote "$REPO_URL" >/dev/null 2>&1; then
      echo
      echo "The server has no access to $REPO_URL yet."
      echo "Add this key in GitHub: repository -> Settings -> Deploy keys -> Add (read-only):"
      echo
      cat "$key.pub"
      echo
      echo "Then run this script again."
      exit 2
    fi
  fi
  as_app git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR/repo"
else
  # Running services use releases/, so the checkout can be brought up to date
  as_app git -C "$APP_DIR/repo" fetch --quiet origin "$BRANCH"
  as_app git -C "$APP_DIR/repo" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
fi

step "Settings file $APP_DIR/shared/server.env"
if [ ! -f "$APP_DIR/shared/server.env" ]; then
  cat > "$APP_DIR/shared/server.env" <<EOF
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
DATABASE_URL=postgresql://$APP_USER@localhost/$APP_USER?host=/var/run/postgresql
UPLOAD_DIR=$DATA_DIR/uploads
FRONTEND_URL=https://$DOMAIN
SITE_URL=https://$DOMAIN
DEPLOY_BRANCH=$BRANCH
BACKUP_DIR=$BACKUP_DIR
BACKUP_KEEP_DAYS=14
# rclone crypt remote for off-site backups, e.g. buysun-crypt:backups
BACKUP_REMOTE=

# Fill in, then: sudo systemctl restart buysun-api
BITRIX_WEBHOOK_URL=
BITRIX_ASSIGNED_BY_ID=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
LEADS_EMAIL_TO=
# Where problem alerts go (default: LEADS_EMAIL_TO)
ALERT_EMAIL_TO=
RETENTION_DAYS=
# Google Drive for anketa copies (OAuth client, see deploy/README.md)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
EOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/shared/server.env"
  chmod 600 "$APP_DIR/shared/server.env"
fi

step "Services"
install -m 644 "$APP_DIR/repo/deploy/systemd/"*.service "$APP_DIR/repo/deploy/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable buysun-api.service >/dev/null

step "First deploy (takes a few minutes)"
as_app "$APP_DIR/repo/deploy/update.sh" --force

# The repository is public, so the password is never in it: it is made here,
# shown once at the end and kept in a file only root and the app can read.
# The cabinet asks to change it and to connect the phone code on first login.
step "First manager of the cabinet: $ADMIN_EMAIL"
FIRST_MANAGER="$APP_DIR/shared/first-manager.txt"
if as_app "$APP_DIR/current/deploy/manager.sh" list | cut -f1 | grep -qxF "$ADMIN_EMAIL"; then
  echo "already there"
else
  as_app "$APP_DIR/current/deploy/manager.sh" add "$ADMIN_EMAIL" "$ADMIN_NAME" > "$FIRST_MANAGER.new"
  install -m 600 -o "$APP_USER" -g "$APP_USER" "$FIRST_MANAGER.new" "$FIRST_MANAGER"
  rm -f "$FIRST_MANAGER.new"
fi

step "First backup (so the health check does not report \"no backups\" until the night)"
ls "$BACKUP_DIR"/*/SHA256SUMS >/dev/null 2>&1 || systemctl start buysun-backup.service

step "Timers: updates from GitHub, backups, restore test, health check"
systemctl enable --now buysun-update.timer buysun-backup.timer buysun-restore-test.timer buysun-healthcheck.timer >/dev/null

step "Web server for $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/repo/deploy/Caddyfile" > /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/log/caddy
chown -R caddy:caddy /var/log/caddy
# Validate as the caddy user: validation also opens the log file
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy
sleep 2
systemctl is-active --quiet caddy || { journalctl -u caddy -n 20 --no-pager; exit 1; }

step "SSH: port${SSH_PORT:+ $SSH_PORT}, fail2ban against password guessing"
ssh_ports() { sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -un | paste -sd' ' || true; }
old_ports="$(ssh_ports)"
SSH_CONF=/etc/ssh/sshd_config.d/10-buysun.conf
if [ -n "${SSH_PORT:-}" ] || [ "${SSH_KEYS_ONLY:-}" = 1 ]; then
  if [ -n "${SSH_PORT:-}" ]; then
    # First the new port next to the old one; the old one goes only when asked
    if [ "${SSH_CLOSE_OLD_PORT:-}" = 1 ]; then new_ports="$SSH_PORT"; else new_ports="$(printf '%s\n' ${old_ports:-22} "$SSH_PORT" | sort -un | paste -sd' ')"; fi
  else
    new_ports="${old_ports:-22}"
  fi
  {
    echo "# Written by deploy/setup-server.sh"
    for p in $new_ports; do echo "Port $p"; done
    if [ "${SSH_KEYS_ONLY:-}" = 1 ]; then
      if [ -s /root/.ssh/authorized_keys ]; then
        echo "PasswordAuthentication no"
        echo "KbdInteractiveAuthentication no"
      else
        echo "SSH_KEYS_ONLY=1 ignored: root has no SSH key, passwords stay on" >&2
      fi
    fi
  } > "$SSH_CONF.new"
  mv "$SSH_CONF.new" "$SSH_CONF"
  sshd -t || { rm -f "$SSH_CONF"; echo "SSH settings are wrong, left as they were" >&2; exit 1; }
  for p in $new_ports; do ufw allow "$p/tcp" >/dev/null; done
  # Ubuntu starts SSH from a socket, which takes its ports from sshd's settings
  systemctl daemon-reload
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then systemctl restart ssh.socket; fi
  systemctl restart ssh 2>/dev/null || systemctl restart sshd
  sleep 1
  for p in $new_ports; do ss -ltn "sport = :$p" | grep -q LISTEN || { echo "SSH does not listen on $p" >&2; exit 1; }; done
  for p in $old_ports; do case " $new_ports " in *" $p "*) ;; *) ufw delete allow "$p/tcp" >/dev/null 2>&1 || true ;; esac; done
fi
ssh_now="$(ssh_ports)"
echo "SSH listens on: ${ssh_now:-22}"

apt-get install -y -q fail2ban >/dev/null
cat > /etc/fail2ban/jail.d/buysun.local <<EOF
# 5 wrong SSH logins in 10 minutes: that address is blocked for an hour
[sshd]
enabled = true
port = $(echo "${ssh_now:-22}" | tr ' ' ',')
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban

step "Firewall: only SSH, HTTP and HTTPS"
for p in ${ssh_now:-22}; do ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

echo
echo "Done. Next:"
echo "  1. Fill in Bitrix24 and SMTP in $APP_DIR/shared/server.env, then: systemctl restart buysun-api"
echo "  2. Point $DOMAIN and www.$DOMAIN (A records) to this server; Caddy gets the certificate itself"
echo "  3. Off-site backups: rclone config (as $APP_USER), set BACKUP_REMOTE, then run"
echo "     sudo -u $APP_USER $APP_DIR/current/server/scripts/restore-test.sh --remote after the first night"
echo "  4. Outside uptime monitor for https://$DOMAIN/api/health (deploy/README.md)"
if [ -f "$FIRST_MANAGER" ]; then
  echo
  echo "Cabinet https://$DOMAIN/admin/  login $ADMIN_EMAIL  temporary password: $(sed -n 's/^Временный пароль: //p' "$FIRST_MANAGER")"
  echo "  (also in $FIRST_MANAGER; delete that file after the first login)"
fi
