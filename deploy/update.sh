#!/usr/bin/env bash
# Deploys the latest commit of the branch from GitHub, if it is new.
# Runs every 5 minutes from buysun-update.timer as the "buysun" user;
# "update.sh --force" redeploys the current commit.
#
# Every version gets its own folder in releases/: the code, the server
# packages and the built site. It is prepared next to the running version and
# switched on in one step only when everything is ready, so a failed update
# (out of memory, no network, a broken build) never touches what is running.
# Packages are installed only when package-lock.json changes; otherwise they
# come from the cache as hard links (instant, no extra disk space). If the new
# API does not start, the previous version is switched back. 5 are kept.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/buysun}"
# Run by the timer the settings come from systemd; run by hand they are read here
. "$(dirname "$0")/load-env.sh"
[ -n "${DATABASE_URL:-}" ] || load_env "$APP_DIR/shared/server.env"
REPO="$APP_DIR/repo"
BRANCH="${DEPLOY_BRANCH:-main}"
RELEASES="$APP_DIR/releases"
CACHE="$APP_DIR/cache"
export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

exec 9>"$APP_DIR/.update.lock"
if [ "${1:-}" = "--force" ]; then
  flock -w 1200 9 || { log "Could not wait for the running update"; exit 1; }
else
  flock -n 9 || { log "Another update is running"; exit 0; }
fi

cd "$REPO"
git fetch --quiet origin "$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"
current="$(cat "$APP_DIR/current/COMMIT" 2>/dev/null || echo none)"
if [ "$target" = "$current" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi
# A version that failed is not tried forever every 5 minutes (a build takes
# the server's only CPU; an API that does not start stops the forms for half a
# minute): a build that failed 3 times, or an API that did not start, waits
# for a new commit or --force. FAILED holds "<commit> <tries>".
FAILED="$APP_DIR/.failed-commit"
tries_of() { local c n; read -r c n < "$FAILED" 2>/dev/null && [ "$c" = "$1" ] && echo "${n:-3}" || echo 0; }
if [ "${1:-}" != "--force" ] && [ "$(tries_of "$target")" -ge 3 ]; then
  log "Not deploying ${target:0:7} again: it failed before. Push a fix to GitHub or run update.sh --force"
  exit 1
fi

log "Deploying ${target:0:7} (was ${current:0:7})"
mkdir -p "$RELEASES" "$CACHE"
release="$RELEASES/${target:0:12}-$(date '+%Y%m%d%H%M%S')"
build="$release.building"
rm -rf "$RELEASES"/*.building
switched=0
on_exit() {
  local status=$?
  rm -rf "$build" # anything unfinished is thrown away
  if [ "$status" -ne 0 ] && [ "$switched" = 0 ]; then
    echo "$target $(( $(tries_of "$target") + 1 ))" > "$FAILED"
    log "ERROR: deploying ${target:0:7} failed; the running version is untouched"
  fi
}
trap on_exit EXIT
mkdir "$build"
git archive "$target" | tar -x -C "$build"
echo "$target" > "$build/COMMIT"

# Packages of one package-lock.json, installed once into the cache. An install
# cut short (power, memory) has no .complete mark and is done again.
# $1: folder with package.json and package-lock.json, $2: cache name, then npm ci options
link_packages() {
  local src="$1" name="$2" key dir
  shift 2
  key="$(cat "$src/package-lock.json" - <<<"$*" | sha256sum | cut -c1-16)"
  dir="$CACHE/$name-$key"
  if [ ! -f "$dir/.complete" ]; then
    log "Installing $name packages (package-lock.json changed)"
    rm -rf "$dir"
    mkdir -p "$dir"
    cp "$src/package.json" "$src/package-lock.json" "$dir/"
    (cd "$dir" && npm ci "$@" --no-audit --no-fund --loglevel=error)
    touch "$dir/.complete"
  fi
  touch "$dir" # recently used: kept by the clean-up below
  cp -al "$dir/node_modules" "$src/node_modules"
}

# Server: packages and the database client (generated fresh, never into the
# shared hard-linked files); migrations run after the site is built
link_packages "$build/server" server --omit=dev
cd "$build/server"
rm -rf node_modules/.prisma
./node_modules/.bin/prisma generate >/dev/null

# Site: build tools are dev dependencies; they always come from the lockfile,
# never downloaded on the fly by npx
link_packages "$build" site --include=dev
cd "$build"
./node_modules/.bin/vite build --logLevel error --outDir "$build/site" --emptyOutDir
# A version keeps only what runs: the server, the built site and these scripts
find "$build" -mindepth 1 -maxdepth 1 ! -name server ! -name site ! -name deploy ! -name COMMIT -exec rm -rf {} +

# Database changes last, once everything else is ready. A switch back to the
# previous version keeps them, so migrations only add (columns, tables) and
# never rename or drop what the previous version still uses.
(cd "$build/server" && ./node_modules/.bin/prisma migrate deploy)

# Switch in one step
mv -T "$build" "$release"
switched=1
previous="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
switch_to() {
  ln -sfn "$1" "$APP_DIR/current.new"
  mv -T "$APP_DIR/current.new" "$APP_DIR/current"
  sudo /usr/bin/systemctl restart buysun-api.service
}
api_up() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

switch_to "$release"
if ! api_up; then
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    log "ERROR: the API did not start on ${target:0:7}; switching back to $(basename "$previous")"
    echo "$target 3" > "$FAILED"
    switch_to "$previous"
    api_up && log "Back on the previous version" || log "ERROR: the previous version did not start either"
  else
    log "ERROR: the API did not start on ${target:0:7}"
  fi
  exit 1
fi
log "Deployed ${target:0:7}"
rm -f "$FAILED"

# Keep the 5 newest releases (never the running one) and caches used in 30 days
running="$(readlink -f "$APP_DIR/current")"
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | { grep -vxF "$running" || true; } | tail -n +5 | xargs -r rm -rf
find "$CACHE" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
