#!/usr/bin/env bash
# Manage the ens-registrar-relay code and systemd service on the GCP VM, from your local machine.
#
# Connection settings are read from .env.gcp at the repo root (gitignored; template in .env.example.gcp).
# Everything runs over `gcloud compute ssh`; git and dependency installs on the VM run as the service user.
#
# shellcheck disable=SC2016  # remote script bodies are intentionally single-quoted; they expand on the VM
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_GCP_FILE:-$ROOT/.env.gcp}

usage() {
  cat <<EOF
Usage: deploy/vm.sh <command> [options]

Commands:
  redeploy [--install]   Pull latest code, install deps if package.json/yarn.lock changed, restart, health-check (default)
  update   [--install]   Pull latest code (+deps when changed) without restarting the service
  restart                Restart the service and health-check it
  status                 Service status, deployed commit, node version
  diff                   Fetch and list the commits the VM is missing (makes no changes)
  logs [-n N] [-f]       Service logs via journalctl (default: last 100 lines; -f to follow)
  health                 Hit the health endpoint from inside the VM
  env-set KEY=VALUE      Set or replace a variable in the VM's .env (timestamped backup kept); restart to apply
  ssh                    Interactive shell on the VM

Config: $ENV_FILE (GCP_PROJECT, GCP_ZONE, GCP_INSTANCE; optional REMOTE_DIR, SERVICE_NAME, SERVICE_USER,
        GIT_REMOTE, GIT_BRANCH, HEALTH_URL). Set VM_DRY_RUN=1 to print the remote script instead of running it.
EOF
}

die() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------- config ----
[ -f "$ENV_FILE" ] || die "config not found: $ENV_FILE (copy .env.example.gcp to .env.gcp and fill it in)"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${GCP_PROJECT:?must be set in $ENV_FILE}"
: "${GCP_ZONE:?must be set in $ENV_FILE}"
: "${GCP_INSTANCE:?must be set in $ENV_FILE}"
REMOTE_DIR=${REMOTE_DIR:-/opt/ens-registrar-relay}
SERVICE_NAME=${SERVICE_NAME:-1ns-registrar-relay}
SERVICE_USER=${SERVICE_USER:-worker}
GIT_REMOTE=${GIT_REMOTE:-origin}
GIT_BRANCH=${GIT_BRANCH:-main}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1/health}

# ------------------------------------------------------------- transport ----
gssh() {
  gcloud compute ssh "$GCP_INSTANCE" --zone "$GCP_ZONE" --project "$GCP_PROJECT" --quiet "$@"
}

# Runs a bash script on the VM. The script is sent over stdin (never appears in the remote process list), prefixed
# with the config variables and REMOTE_LIB. Extra KEY=VALUE args are exported to the remote script as well.
remote_run() {
  local body=$1
  shift
  local script
  script=$(
    printf 'set -euo pipefail\n'
    printf '%s=%q\n' \
      REMOTE_DIR "$REMOTE_DIR" SERVICE_NAME "$SERVICE_NAME" SERVICE_USER "$SERVICE_USER" \
      GIT_REMOTE "$GIT_REMOTE" GIT_BRANCH "$GIT_BRANCH" HEALTH_URL "$HEALTH_URL"
    for kv in "$@"; do
      printf '%s=%q\n' "${kv%%=*}" "${kv#*=}"
    done
    printf '%s\n%s\n' "$REMOTE_LIB" "$body"
  )
  if [ "${VM_DRY_RUN:-}" = 1 ]; then
    printf '%s\n' "$script"
    return 0
  fi
  printf '%s\n' "$script" | gssh --command 'bash -s' -- -o ConnectTimeout=30
}

# ---------------------------------------------- helpers that run on the VM ----
read -r -d '' REMOTE_LIB <<'EOF' || true
as_user() { sudo -u "$SERVICE_USER" -H "$@"; }
short() { as_user git -C "$REMOTE_DIR" rev-parse --short "$1"; }

health_check() {
  local tries=${1:-20} i code=
  for i in $(seq 1 "$tries"); do
    sleep 1
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || true)
    if [ -n "$code" ] && [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 400 ]; then
      echo "healthy: $HEALTH_URL -> HTTP $code"
      return 0
    fi
  done
  echo "service did not become healthy within ${tries}s (last HTTP status: ${code:-none}); recent logs:" >&2
  sudo journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2
  return 1
}

restart_service() {
  echo "restarting $SERVICE_NAME ..."
  sudo systemctl restart "$SERVICE_NAME"
  health_check 20
  systemctl status --no-pager -n 0 "$SERVICE_NAME" | sed -n '1,5p'
}

# Fast-forwards the checkout to GIT_REMOTE/GIT_BRANCH. Sets OLD_REV / NEW_REV.
update_code() {
  cd "$REMOTE_DIR"
  local branch
  branch=$(as_user git rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "$GIT_BRANCH" ]; then
    echo "VM has branch '$branch' checked out, expected '$GIT_BRANCH'; refusing to update" >&2
    exit 1
  fi
  if [ -n "$(as_user git status --porcelain --untracked-files=no)" ]; then
    echo "VM working tree has local modifications; refusing to update:" >&2
    as_user git status --short --untracked-files=no >&2
    exit 1
  fi
  OLD_REV=$(as_user git rev-parse HEAD)
  echo "fetching $GIT_REMOTE/$GIT_BRANCH ..."
  as_user git fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH"
  as_user git merge --ff-only --quiet "$GIT_REMOTE/$GIT_BRANCH"
  NEW_REV=$(as_user git rev-parse HEAD)
  if [ "$OLD_REV" = "$NEW_REV" ]; then
    echo "code already up to date at $(short "$NEW_REV")"
  else
    echo "code updated $(short "$OLD_REV") -> $(short "$NEW_REV"):"
    as_user git log --oneline "$OLD_REV..$NEW_REV"
  fi
}

# The VM has no global yarn; yarn 1 is fetched through npx so yarn.lock is honoured exactly.
install_deps() {
  local force=${1:-0}
  cd "$REMOTE_DIR"
  if [ "$force" = 1 ] || ! as_user git diff --quiet "$OLD_REV" "$NEW_REV" -- package.json yarn.lock; then
    echo "installing dependencies from yarn.lock (node $(node --version)) ..."
    if command -v yarn >/dev/null 2>&1; then
      as_user yarn install --frozen-lockfile --non-interactive
    else
      as_user npx --yes yarn@1.22.22 install --frozen-lockfile --non-interactive
    fi
  else
    echo "package.json/yarn.lock unchanged; skipping dependency install (use --install to force)"
  fi
}
EOF

# ---------------------------------------------------------------- commands ----
cmd_status() {
  remote_run '
cd "$REMOTE_DIR"
echo "instance: $(hostname)   node $(node --version)"
echo "deployed: $(as_user git log -1 --format="%h %ad %s" --date=short) [$(as_user git rev-parse --abbrev-ref HEAD)]"
mods=$(as_user git status --porcelain --untracked-files=no | wc -l | tr -d " ")
[ "$mods" = 0 ] || echo "warning: $mods locally modified tracked file(s) on the VM"
echo
systemctl status --no-pager -n 0 "$SERVICE_NAME" || true
'
}

cmd_diff() {
  remote_run '
cd "$REMOTE_DIR"
as_user git fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH"
head=$(as_user git rev-parse HEAD)
target=$(as_user git rev-parse "$GIT_REMOTE/$GIT_BRANCH")
echo "VM: $(short "$head")   $GIT_REMOTE/$GIT_BRANCH: $(short "$target")"
ahead=$(as_user git rev-list --count "$target..$head")
[ "$ahead" = 0 ] || echo "warning: VM has $ahead commit(s) not on $GIT_REMOTE/$GIT_BRANCH; fast-forward update will fail"
if [ "$head" = "$target" ]; then
  echo "VM is up to date"
else
  echo "commits to deploy:"
  as_user git log --oneline "$head..$target"
  if ! as_user git diff --quiet "$head" "$target" -- package.json yarn.lock; then
    echo "dependencies changed: redeploy will run yarn install"
  fi
fi
mods=$(as_user git status --porcelain --untracked-files=no)
[ -z "$mods" ] || { echo "warning: VM working tree has local modifications (update will refuse):"; echo "$mods"; }
'
}

cmd_update() {
  remote_run '
update_code
install_deps "$INSTALL"
echo "done; service NOT restarted (run: deploy/vm.sh restart)"
' "INSTALL=$1"
}

cmd_redeploy() {
  remote_run '
update_code
install_deps "$INSTALL"
restart_service
' "INSTALL=$1"
}

cmd_restart() {
  remote_run 'restart_service'
}

cmd_health() {
  remote_run '
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" || true)
echo "$HEALTH_URL -> HTTP ${code:-none}"
[ -n "$code" ] && [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 400 ]
'
}

cmd_logs() {
  local lines=100 follow=
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) lines=${2:?-n requires a number}; shift 2 ;;
      -f) follow=-f; shift ;;
      *) die "unknown logs option: $1" ;;
    esac
  done
  if [ -n "$follow" ]; then
    gssh --command "sudo journalctl -u $SERVICE_NAME -n $lines -f" -- -t
  else
    gssh --command "sudo journalctl -u $SERVICE_NAME -n $lines --no-pager"
  fi
}

cmd_env_set() {
  local kv=${1:?usage: deploy/vm.sh env-set KEY=VALUE}
  local key=${kv%%=*} value=${kv#*=}
  [ "$key" != "$kv" ] || die "expected KEY=VALUE"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid variable name: $key"
  # KEY/VALUE travel inside the ssh stdin stream; the value is never part of a remote command line
  remote_run '
f="$REMOTE_DIR/.env"
[ -f "$f" ] || { echo "no .env at $f" >&2; exit 1; }
backup="$f.bak.$(date +%Y%m%d-%H%M%S)"
sudo cp -p "$f" "$backup"
tmp=$(mktemp)
found=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "$ENV_KEY="*) printf "%s=%s\n" "$ENV_KEY" "$ENV_VALUE"; found=1 ;;
    *) printf "%s\n" "$line" ;;
  esac
done < "$f" > "$tmp"
[ "$found" = 1 ] || printf "%s=%s\n" "$ENV_KEY" "$ENV_VALUE" >> "$tmp"
sudo cp "$tmp" "$f"   # copying onto the existing file keeps its owner and mode
rm -f "$tmp"
if [ "$found" = 1 ]; then echo "$ENV_KEY replaced in $f"; else echo "$ENV_KEY added to $f"; fi
echo "backup: $backup"
echo "the service reads .env only at startup; run: deploy/vm.sh restart"
' "ENV_KEY=$key" "ENV_VALUE=$value"
}

cmd_ssh() {
  gssh
}

# -------------------------------------------------------------------- main ----
parse_install_flag() {
  INSTALL=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --install) INSTALL=1 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
}

cmd=${1:-redeploy}
[ $# -eq 0 ] || shift
case "$cmd" in
  redeploy) parse_install_flag "$@"; cmd_redeploy "$INSTALL" ;;
  update) parse_install_flag "$@"; cmd_update "$INSTALL" ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  diff) cmd_diff ;;
  logs) cmd_logs "$@" ;;
  health) cmd_health ;;
  env-set) cmd_env_set "$@" ;;
  ssh) cmd_ssh ;;
  -h|--help|help) usage ;;
  *) usage >&2; die "unknown command: $cmd" ;;
esac
