#!/usr/bin/env bash
# Managers of the cabinet on the server, run as the buysun user:
#   sudo -u buysun /opt/buysun/current/deploy/manager.sh add anna@buysun.kz "Анна Ли"
# See server/scripts/manager.js for all commands.
set -euo pipefail
. "$(dirname "$0")/load-env.sh"
load_env /opt/buysun/shared/server.env
cd /opt/buysun/current/server
exec node scripts/manager.js "$@"
