#!/usr/bin/env bash
# Proves the latest backup can actually be restored: restores it into a
# temporary database and folder, checks the lead and file counts and that
# every file in the database exists, then removes everything temporary.
# Run after setting up backups and then every few months.
#   restore-test.sh                 latest local backup
#   restore-test.sh <backup folder> a specific one
#   restore-test.sh --remote        latest off-site backup (downloads it first:
#                                   db/<latest date> and the uploads/ folder)
set -euo pipefail
. "$(dirname "$0")/common.sh"

work="$(mktemp -d)"
test_db="buysun_restore_test_$$"
admin_url="$(db_url_named postgres)"
cleanup() {
  psql "$admin_url" -qc "DROP DATABASE IF EXISTS $test_db" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ "${1:-}" = "--remote" ]; then
  : "${BACKUP_REMOTE:?BACKUP_REMOTE is not set}"
  latest="$(rclone lsf --dirs-only "$BACKUP_REMOTE/db" | sort | tail -1)"
  [ -n "$latest" ] || { echo "No off-site backups found"; exit 1; }
  rclone copy "$BACKUP_REMOTE/db/$latest" "$work/backup"
  src="$work/backup"
  # The anketa files are not downloaded (they could fill the disk): their list
  # with sizes, read from the off-site storage, is checked instead
  rclone lsf -R --files-only --format ps --separator ' ' "$BACKUP_REMOTE/uploads" | LC_ALL=C sort > "$work/present.list"
elif [ -n "${1:-}" ]; then
  src="$1"
else
  src="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
  [ -n "$src" ] || { echo "No backups in $BACKUP_DIR"; exit 1; }
fi
log "Testing backup $src"

psql "$admin_url" -qc "CREATE DATABASE $test_db"
test_url="$(db_url_named "$test_db")"
# The database is restored for real; the files are checked where they are, not
# copied: a full copy of every anketa photo would need as much free disk again
RESTORE_DB_URL="$test_url" RESTORE_FILES=no "$(dirname "$0")/restore.sh" "$src" >/dev/null
[ -f "$work/present.list" ] || (cd "$src/uploads" && find . -type f -printf '%P %s\n' | LC_ALL=C sort) > "$work/present.list"

expected="$(tr '\n' ' ' < "$src/counts.txt")"
actual="$(psql "$test_url" -Atc "SELECT 'leads=' || count(*) FROM leads UNION ALL SELECT 'files=' || count(*) FROM lead_files" | tr '\n' ' ')"
[ "$expected" = "$actual" ] || { echo "FAILED: backup had $expected, restored $actual"; exit 1; }

# Every file the restored database lists is in the backup, with its size
psql "$test_url" -Atc "SELECT path || ' ' || size FROM lead_files" | LC_ALL=C sort > "$work/needed.list"
missing="$(LC_ALL=C comm -23 "$work/needed.list" "$work/present.list")"
if [ -n "$missing" ]; then
  echo "$missing" | head -5 | sed 's/^/Missing file: /'
  echo "FAILED: $(echo "$missing" | wc -l) files missing"
  exit 1
fi

log "Restore test OK: $actual"
