#!/usr/bin/env bash
# scripts/migrate.sh
#
# Production-grade database migration script for the monorepo.
# - Loads env (optional --env-file)
# - Waits for Postgres to be reachable
# - Runs Prisma generate + migrate (deploy by default, dev when --dev)
# - Applies extra SQL files (e.g., FTS triggers)
# - Runs TypeScript migration helpers/backfills (optional)
# - Optional seeding (--seed)
#
# Usage:
#   scripts/migrate.sh [--env-file .env] [--dev] [--seed] [--skip-sql] [--skip-prisma]
#                      [--skip-backfill] [--timeout 60] [--schema packages/db/prisma/schema.prisma]
#
# Env:
#   DATABASE_URL                  (required)
#   SHADOW_DATABASE_URL           (optional, for prisma migrate dev)
#   PRISMA_LOG_LEVEL=info|warn|error (optional)
#   EXTRA_SQL_DIR=packages/db/prisma/sql (optional)
#   PRISMA_MIGRATIONS_DIR=packages/db/prisma/migrations (optional)
#   DB_HOST/DB_PORT/DB_USER/DB_NAME/DB_PASSWORD (optional fallback to build DATABASE_URL)
#
set -euo pipefail

### -------- logging helpers --------
log()  { printf "\033[1;34m[ MIGRATE ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   OK   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  WARN  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" 1>&2; }

### -------- defaults --------
ENV_FILE=""
USE_DEV="0"
DO_SEED="0"
SKIP_SQL="0"
SKIP_PRISMA="0"
SKIP_BACKFILL="0"
TIMEOUT="90"
SCHEMA_PATH="packages/db/prisma/schema.prisma"
EXTRA_SQL_DIR="${EXTRA_SQL_DIR:-packages/db/prisma/sql}"
PRISMA_MIGRATIONS_DIR="${PRISMA_MIGRATIONS_DIR:-packages/db/prisma/migrations}"
PRISMA_LOG_LEVEL="${PRISMA_LOG_LEVEL:-info}"

### -------- arg parse --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)          ENV_FILE="${2-}"; shift 2;;
    --dev)               USE_DEV="1"; shift;;
    --seed)              DO_SEED="1"; shift;;
    --skip-sql)          SKIP_SQL="1"; shift;;
    --skip-prisma)       SKIP_PRISMA="1"; shift;;
    --skip-backfill)     SKIP_BACKFILL="1"; shift;;
    --timeout)           TIMEOUT="${2-}"; shift 2;;
    --schema)            SCHEMA_PATH="${2-}"; shift 2;;
    -h|--help)
      cat <<EOF
Usage: $0 [options]

Options:
  --env-file <path>        Source environment variables from file before running
  --dev                    Use 'prisma migrate dev' (default is 'migrate deploy')
  --seed                   Run TypeScript seed after migrations
  --skip-sql               Skip raw SQL files in ${EXTRA_SQL_DIR}
  --skip-prisma            Skip Prisma generate/migrate (only apply SQL/backfills)
  --skip-backfill          Skip TS backfill scripts
  --timeout <sec>          Max seconds to wait for DB readiness (default ${TIMEOUT})
  --schema <path>          Prisma schema path (default ${SCHEMA_PATH})
  -h, --help               Show this help
EOF
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      exit 2
      ;;
  esac
done

### -------- small utils --------
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

apply_sql_files() {
  local dir="$1"
  if [[ ! -d "${dir}" ]]; then
    warn "SQL dir '${dir}' not found; skipping extra SQL."
    return 0
  fi

  shopt -s nullglob
  local files=("${dir}"/*.sql)
  if (( ${#files[@]} == 0 )); then
    warn "No *.sql files in '${dir}'; skipping."
    return 0
  fi

  log "Applying raw SQL files in ${dir} (ON_ERROR_STOP)…"
  for f in "${files[@]}"; do
    log "  -> $(basename "$f")"
    PGPASSWORD="$(echo "$DATABASE_URL" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')" \
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  done
  ok "Applied ${#files[@]} SQL files."
}

run_prisma() {
  if [[ "${SKIP_PRISMA}" == "1" ]]; then
    warn "Skipping Prisma steps (--skip-prisma)."
    return 0
  fi

  require_cmd pnpm

  if [[ ! -f "${SCHEMA_PATH}" ]]; then
    err "Prisma schema not found at '${SCHEMA_PATH}'."
    exit 1
  fi

  log "Prisma generate (schema=${SCHEMA_PATH})"
  PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}" \
  pnpm --filter @bowdoin/db exec prisma generate --schema "${SCHEMA_PATH}" \
    1>/dev/null

  if [[ "${USE_DEV}" == "1" ]]; then
    log "Prisma migrate dev (non-prod flow)"
    if [[ -z "${SHADOW_DATABASE_URL:-}" ]]; then
      warn "SHADOW_DATABASE_URL not set; prisma may create a temporary shadow DB."
    fi
    pnpm --filter @bowdoin/db exec prisma migrate dev \
      --schema "${SCHEMA_PATH}" \
      --create-only=false \
      --skip-seed \
      --name "auto" \
      1>/dev/null
  else
    log "Prisma migrate deploy (prod-safe)"
    pnpm --filter @bowdoin/db exec prisma migrate deploy \
      --schema "${SCHEMA_PATH}" \
      1>/dev/null
  fi
  ok "Prisma migrations complete."
}

run_ts_migrations() {
  if [[ "${SKIP_BACKFILL}" == "1" ]]; then
    warn "Skipping TypeScript migration/backfill scripts (--skip-backfill)."
    return 0
  fi

  # Use tsx to run TS/ESM without transpiling
  if ! pnpm --filter @bowdoin/db exec tsx --version >/dev/null 2>&1; then
    warn "tsx not available in @bowdoin/db; skipping TS migration helpers."
    return 0
  fi

  # Optional helper: packages/db/src/migrate.ts
  if [[ -f "packages/db/src/migrate.ts" ]]; then
    log "Running TS migration helper: packages/db/src/migrate.ts"
    pnpm --filter @bowdoin/db exec tsx packages/db/src/migrate.ts
  fi

  # Optional backfill: packages/db/scripts/backfill-affiliation.mts
  if [[ -f "packages/db/scripts/backfill-affiliation.mts" ]]; then
    log "Running backfill: packages/db/scripts/backfill-affiliation.mts"
    pnpm --filter @bowdoin/db exec tsx packages/db/scripts/backfill-affiliation.mts
  fi

  ok "TypeScript migration/backfill scripts done."
}

run_seed() {
  if [[ "${DO_SEED}" != "1" ]]; then
    return 0
  fi

  if pnpm --filter @bowdoin/db exec tsx --version >/dev/null 2>&1; then
    if [[ -f "packages/db/src/seed.ts" ]]; then
      log "Seeding database via packages/db/src/seed.ts"
      pnpm --filter @bowdoin/db exec tsx packages/db/src/seed.ts
      ok "Seeding complete."
      return 0
    fi
  fi

  warn "Seed requested but no seed runner found; skipping."
}

### -------- main --------
main() {
  # Load env first (so DATABASE_URL is available to readiness check)
  source_env

  require_cmd psql
  require_cmd sed

  compose_database_url_if_missing
  export DATABASE_URL

  log "Database URL: ${DATABASE_URL}"
  wait_for_postgres "${DATABASE_URL}" "${TIMEOUT}"

  run_prisma

  if [[ "${SKIP_SQL}" == "1" ]]; then
    warn "Skipping extra SQL files (--skip-sql)."
  else
    apply_sql_files "${EXTRA_SQL_DIR}"
  fi

  run_ts_migrations
  run_seed

  ok "All migration steps finished successfully."
}

trap 'err "Migration script failed on line $LINENUMBER (exit $?)"' ERR
main "$@"