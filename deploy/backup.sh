#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
config=${1:-/etc/itd-studio/backup.env}
# Configuration is a trusted, root-owned shell file, never an uploaded file.
source "$config"
: "${ITD_USER:?}" "${ITD_HOME:?}" "${ITD_APP_DIR:?}" "${ITD_BACKUP_DIR:?}" "${ITD_SERVICE:?}"
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}"
if [[ "$RESTIC_REPOSITORY" == REPLACE_* ]]; then
  echo 'External backup repository has not been configured' >&2; exit 1
fi
if [[ -n ${RESTIC_CREDENTIALS_FILE:-} ]]; then source "$RESTIC_CREDENTIALS_FILE"; fi
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
KEEP_DAILY=${KEEP_DAILY:-14}; KEEP_WEEKLY=${KEEP_WEEKLY:-8}; KEEP_MONTHLY=${KEEP_MONTHLY:-12}
KEEP_LOCAL=${KEEP_LOCAL:-2}
for value in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY" "$KEEP_LOCAL"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo 'Retention must be a positive integer' >&2; exit 1; }
done
# Install /run/lock/itd-studio-backup.lock as part of the service account setup.
exec 9>"${ITD_BACKUP_LOCK:-/run/lock/itd-studio-backup.lock}"
flock -n 9 || { echo 'Another backup is running' >&2; exit 1; }
restart_needed=0
restart_marker=${ITD_RESTART_MARKER:-/run/itd-studio-backup-restart}
finish() {
  result=$?
  trap - EXIT
  if (( restart_needed )); then
    if ! systemctl start "$ITD_SERVICE"; then
      echo 'CRITICAL: application could not restart after backup' >&2; result=1
    else
      rm -f "$restart_marker"
    fi
  fi
  if (( result )); then echo 'ITD backup FAILED; inspect the backup service journal' >&2; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl is-active --quiet "$ITD_SERVICE" || { echo 'Application is not active; refusing an unattended backup' >&2; exit 1; }
restart_needed=1
touch "$restart_marker"
systemctl stop "$ITD_SERVICE"
folder=$(runuser -u "$ITD_USER" -- env HOME="$ITD_HOME" /usr/bin/node "$ITD_APP_DIR/deploy/backup-copy.mjs" "$ITD_BACKUP_DIR")
[[ -d "$folder" && -f "$folder/backup.json" ]] || { echo 'No verified local backup produced' >&2; exit 1; }
systemctl start "$ITD_SERVICE"
restart_needed=0
rm -f "$restart_marker"
systemctl is-active --quiet "$ITD_SERVICE"
# Restic encrypts locally before transport. Never upload the raw folder with other tools.
restic backup --tag itd-studio --host itd-studio "$folder"
restic check
# Retain previous snapshots; never run retention after a failed backup/check.
# Paths change with each snapshot, so group by stable host+tag rather than paths.
restic forget --tag itd-studio --host itd-studio --group-by host,tags \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune
runuser -u "$ITD_USER" -- env HOME="$ITD_HOME" /usr/bin/node "$ITD_APP_DIR/deploy/prune-local.mjs" "$ITD_BACKUP_DIR" "$folder" "$KEEP_LOCAL"
echo 'ITD verified encrypted offsite backup completed'
