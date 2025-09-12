#!/usr/bin/env bash
# scripts/seed.sh
#
# Production-grade database seeding runner for the monorepo.
# - Loads env (optional --env-file)
# - (Optionally) waits for Postgres to be reachable
# - Executes the TypeScript seed entrypoint (packages/db/src/seed.ts)
# - Allows selecting a specific seed module (e.g., community seed)
# - Supports dry-run and confirmation protections in production
#
# Usage:
#   scripts/seed.sh [--env-file .env] [--timeout 60] [--skip-wait]
#                   [--script packages/db/seed/community.seed.ts]
#                   [--dry-run] [--yes]
#
# Environment:
#   DATABASE_URL (required) – connection string for Prisma/psql
#   PRISMA_LOG_LEVEL=info|warn|error (optional)
#   NODE_OPTIONS (optional)
#
set -euo pipefail

### ------------- logging -------------
log()  { printf "\033[1;34m[  SEED  ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   OK   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  WARN  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" 1>&2; }

### ------------- defaults -------------
ENV_FILE=""
TIMEOUT="60"
SKIP_WAIT="0"
DRY_RUN="0"
ASSUME_YES="0"
PRISMA_LOG_LEVEL="${PRISMA_LOG_LEVEL:-info}"

# TS entrypoint (exists in repo)
SEED_ENTRY="packages/db/src/seed.ts"
# Optional concrete seed module (e.g., community)
SEED_SCRIPT=""

### ------------- args -------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)   ENV_FILE="${2-}"; shift 2;;
    --timeout)    TIMEOUT="${2-}"; shift 2;;
    --skip-wait)  SKIP_WAIT="1"; shift;;
    --dry-run)    DRY_RUN="1"; shift;;
    --yes|-y)     ASSUME_YES="1"; shift;;
    --script)     SEED_SCRIPT="${2-}"; shift 2;;
    -h|--help)
      cat <<EOF
Usage: $0 [options]

Options:
  --env-file <path>   Source environment variables before running
  --timeout <sec>     Wait up to N seconds for DB readiness (default ${TIMEOUT})
  --skip-wait         Do not wait for DB (assume it's ready)
  --dry-run           Pass a dry-run flag down to the seed runner (no writes)
  --script <path>     Specific TS seed module (e.g. packages/db/seed/community.seed.ts)
  --yes, -y           Do not prompt for confirmation (non-interactive/prod-safe)
  -h, --help          Show this help
EOF
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      exit 2
      ;;
  esac
done

### ------------- helpers -------------
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command '$1'. Please install it."
    exit 127
  fi
}

source_env() {
  if [[ -n "${ENV_FILE}" ]]; then
    if [[ -f "${ENV_FILE}" ]]; then
      log "Loading environment from ${ENV_FILE}"
      # shellcheck disable=SC1090
      set -a ; . "${ENV_FILE}" ; set +a
    else
      err "--env-file '${ENV_FILE}' not found"
      exit 1
    fi
  fi
}

compose_database_url_if_missing() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    if [[ -n "${DB_HOST:-}" && -n "${DB_PORT:-}" && -n "${DB_USER:-}" && -n "${DB_NAME:-}" ]]; then
      local pass_part=""
      if [[ -n "${DB_PASSWORD:-}" ]]; then pass_part=":${DB_PASSWORD}"; fi
      export DATABASE_URL="postgresql://${DB_USER}${pass_part}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
      warn "DATABASE_URL not set; composed from DB_* into: ${DATABASE_URL}"
    else
      err "DATABASE_URL not set and DB_* vars are insufficient."
      exit 1
    fi
  fi
}

wait_for_postgres() {
  local url="$1" timeout="$2" start now
  start="$(date +%s)"
  log "Waiting for Postgres to be ready (timeout ${timeout}s)…"
  until PGPASSWORD="$(echo "$url" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')" \
        psql "$url" -XtAc "select 1" >/dev/null 2>&1; do
    now="$(date +%s)"
    if (( now - start > timeout )); then
      err "Timed out after ${timeout}s waiting for Postgres."
      return 1
    fi
    sleep 2
  done
  ok "Postgres is reachable."
}

confirm_if_prod() {
  # Heuristic: consider anything not "development|dev|test|local" as prod-ish
  local node_env="${NODE_ENV:-}"
  if [[ "${ASSUME_YES}" == "1" ]]; then
    return 0
  fi
  case "${node_env,,}" in
    dev|development|test|local|"") return 0 ;;
    *) 
      warn "You are about to RUN SEEDS with NODE_ENV='${NODE_ENV:-unset}'."
      read -r -p "Proceed? (type 'seed' to confirm) " answer
      if [[ "${answer}" != "seed" ]]; then
        err "Aborted by user."
        exit 1
      fi
      ;;
  esac
}

### ------------- main -------------
main() {
  source_env
  require_cmd pnpm
  require_cmd psql
  require_cmd sed

  compose_database_url_if_missing
  export DATABASE_URL

  if [[ "${SKIP_WAIT}" != "1" ]]; then
    wait_for_postgres "${DATABASE_URL}" "${TIMEOUT}"
  else
    warn "Skipping DB readiness check (--skip-wait)."
  fi

  confirm_if_prod

  if [[ ! -f "${SEED_ENTRY}" ]]; then
    err "Seed entrypoint '${SEED_ENTRY}' not found."
    exit 1
  fi

  local args=()
  if [[ -n "${SEED_SCRIPT}" ]]; then
    if [[ ! -f "${SEED_SCRIPT}" ]]; then
      err "Specified --script '${SEED_SCRIPT}' not found."
      exit 1
    fi
    log "Using specific seed script: ${SEED_SCRIPT}"
    args+=( "--script" "${SEED_SCRIPT}" )
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    warn "Running in DRY-RUN mode (no writes if respected by seed)."
    args+=( "--dry-run" )
  fi

  log "Executing TS seed runner via pnpm/tsx…"
  # We run within the @bowdoin/db workspace so local deps (prisma, tsx) are available.
  PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}" \
  PRISMA_LOG_LEVEL="${PRISMA_LOG_LEVEL}" \
  pnpm --filter @bowdoin/db exec tsx "${SEED_ENTRY}" "${args[@]}"

  ok "Seeding complete."
}

trap 'err "Seed script failed on line $LINENO (exit $?)"' ERR
main "$@"