#!/usr/bin/env bash
# scripts/restore-db.sh
#
# Production-grade PostgreSQL logical restore script for pg_dump custom-format
# artifacts produced by scripts/backup-db.sh.
#
# Capabilities
# - Source an artifact from: local file, local folder (pick latest), S3/MinIO prefix (pick latest)
# - Optional checksum verification (.sha256) and manifest reading
# - Decrypt age(.age) or gpg(.gpg) artifacts
# - Safety prompts unless --force
# - Waits for DB reachability (optional --skip-wait)
# - Parallel pg_restore jobs, optional --clean/--if-exists, schema-only/data-only
# - Optional include/exclude tables, schema only or data only
# - Post-restore ANALYZE (optional)
#
# Usage:
#   scripts/restore-db.sh \
#     [--env-file .env] [--db-url postgres://...] [--timeout 60] [--skip-wait] [--force] \
#     [--artifact /path/to/FILE.dump|.dump.age|.dump.gpg] \
#     [--from-dir ./backups --prefix db_myapp] \
#     [--from-s3 s3://bucket/path/prefix] [--use-mc] [--s3-endpoint https://minio:9000] \
#     [--jobs 4] [--clean] [--if-exists] [--schema-only|--data-only] \
#     [--include 'public.*'] [--exclude 'audit_*'] [--no-analyze] [--dry-run]
#
# Notes:
# - If neither --artifact nor --from-* provided, we look in ./backups for most recent file.
# - DATABASE_URL may be built from DB_* parts if not provided.
# - For S3, you need awscli creds (or use --use-mc with pre-configured `mc` alias/env).
#
set -euo pipefail

### ---------- logging ----------
log()  { printf "\033[1;34m[ restore ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   ok   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  warn  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" 1>&2; }

### ---------- defaults ----------
ENV_FILE=""
DB_URL="${DATABASE_URL:-}"
TIMEOUT="60"
SKIP_WAIT="0"
FORCE="0"
JOBS="${PG_RESTORE_JOBS:-4}"
CLEAN="0"
IF_EXISTS="0"
SCHEMA_ONLY="0"
DATA_ONLY="0"
INCLUDE_TABLE=""
EXCLUDE_TABLE=""
NO_ANALYZE="0"
DRY_RUN="0"

ARTIFACT=""     # explicit file path
FROM_DIR=""     # look for latest in a local dir
PREFIX=""       # optional prefix to narrow search in FROM_DIR
FROM_S3=""      # s3://bucket/path/prefix to search for latest
USE_MC="0"
S3_ENDPOINT=""

### ---------- args ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)     ENV_FILE="${2:-}"; shift 2;;
    --db-url)       DB_URL="${2:-}"; shift 2;;
    --timeout)      TIMEOUT="${2:-}"; shift 2;;
    --skip-wait)    SKIP_WAIT="1"; shift;;
    --force)        FORCE="1"; shift;;
    --jobs)         JOBS="${2:-}"; shift 2;;
    --clean)        CLEAN="1"; shift;;
    --if-exists)    IF_EXISTS="1"; shift;;
    --schema-only)  SCHEMA_ONLY="1"; shift;;
    --data-only)    DATA_ONLY="1"; shift;;
    --include|-t)   INCLUDE_TABLE="${2:-}"; shift 2;;
    --exclude|-T)   EXCLUDE_TABLE="${2:-}"; shift 2;;
    --no-analyze)   NO_ANALYZE="1"; shift;;
    --dry-run)      DRY_RUN="1"; shift;;
    --artifact)     ARTIFACT="${2:-}"; shift 2;;
    --from-dir)     FROM_DIR="${2:-}"; shift 2;;
    --prefix)       PREFIX="${2:-}"; shift 2;;
    --from-s3)      FROM_S3="${2:-}"; shift 2;;
    --use-mc)       USE_MC="1"; shift;;
    --s3-endpoint)  S3_ENDPOINT="${2:-}"; shift 2;;
    -h|--help)
      sed -n '1,140p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) err "Unknown arg: $1"; exit 2;;
  esac
done

### ---------- helpers ----------
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command '$1'. Install it and retry."
    exit 127
  fi
}

source_env() {
  if [[ -n "${ENV_FILE}" ]]; then
    if [[ -f "${ENV_FILE}" ]]; then
      log "Loading env from ${ENV_FILE}"
      # shellcheck disable=SC1090
      set -a; . "${ENV_FILE}"; set +a
    else
      err "--env-file '${ENV_FILE}' not found"
      exit 1
    fi
  fi
}

compose_database_url_if_missing() {
  if [[ -z "${DB_URL}" ]]; then
    if [[ -z "${DATABASE_URL:-}" ]]; then
      if [[ -n "${DB_HOST:-}" && -n "${DB_PORT:-}" && -n "${DB_USER:-}" && -n "${DB_NAME:-}" ]]; then
        local pass_part=""
        if [[ -n "${DB_PASSWORD:-}" ]]; then pass_part=":${DB_PASSWORD}"; fi
        DB_URL="postgresql://${DB_USER}${pass_part}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
        warn "DATABASE_URL not set; composed from DB_* -> ${DB_URL}"
      else
        err "No DB URL. Provide --db-url or set DATABASE_URL or DB_* variables."
        exit 1
      fi
    else
      DB_URL="${DATABASE_URL}"
    fi
  fi
}

wait_for_postgres() {
  local url="$1" timeout="$2" start now
  require_cmd psql
  start="$(date +%s)"
  log "Waiting for Postgres readiness (timeout ${timeout}s)…"
  until psql "$url" -XtAc "select 1" >/dev/null 2>&1; do
    now="$(date +%s)"
    if (( now - start > timeout )); then
      err "Timed out waiting for Postgres."
      return 1
    fi
    sleep 2
  done
  ok "Postgres reachable."
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

pick_latest_local() {
  local dir="$1" prefix="$2"
  [[ -d "$dir" ]] || { err "Directory not found: $dir"; exit 1; }
  local pattern="*.dump *.dump.age *.dump.gpg"
  if [[ -n "$prefix" ]]; then
    pattern="${prefix}*.dump ${prefix}*.dump.age ${prefix}*.dump.gpg"
  fi
  local latest
  latest="$(ls -1t ${dir}/{${pattern}} 2>/dev/null | head -n1 || true)"
  if [[ -z "$latest" ]]; then
    err "No dump artifact found in ${dir} (prefix='${prefix}')"
    exit 1
  fi
  echo "$latest"
}

download_latest_from_s3() {
  local s3prefix="$1" tmpdir="$2"
  mkdir -p "$tmpdir"
  if [[ "${USE_MC}" == "1" ]]; then
    require_cmd mc
    log "Listing ${s3prefix} via mc to find latest artifact…"
    # We expect artifacts to be stored under …/<PREFIX>/<dbname>/<timestamp>/*.dump*
    # Pull listing, pick newest timestamp folder, then select *.dump* file.
    local newest_folder dumpfile
    newest_folder="$(mc ls "${s3prefix%/}"/ | awk '{print $6}' | sort | tail -n1)"
    [[ -n "$newest_folder" ]] || { err "No subfolders under ${s3prefix}"; exit 1; }
    log "Latest folder: $newest_folder"
    mc cp -r "${s3prefix%/}/${newest_folder}" "$tmpdir/"
    dumpfile="$(ls -1t "$tmpdir/$newest_folder"/*.dump* | head -n1)"
    [[ -f "$dumpfile" ]] || { err "No *.dump* found in latest folder"; exit 1; }
    echo "$dumpfile"
  else
    require_cmd aws
    local extra=()
    if [[ -n "${S3_ENDPOINT}" ]]; then extra+=( --endpoint-url "${S3_ENDPOINT}" ); fi
    log "Discovering latest under ${s3prefix} via aws s3…"
    # List, filter for .dump, .dump.age, .dump.gpg keys, pick newest by (assume lexicographically sorted timestamp).
    local key
    key="$(aws s3 ls "${s3prefix%/}/" "${extra[@]}" \
      | awk '{print $4}' | egrep '\.dump(\.age|\.gpg)?$' | sort | tail -n1)"
    [[ -n "$key" ]] || { err "No dump artifact under ${s3prefix}"; exit 1; }
    log "Latest key: $key"
    aws s3 cp "${s3prefix%/}/${key}" "$tmpdir/" "${extra[@]}"
    # Also try to grab checksum + manifest if present
    aws s3 cp "${s3prefix%/}/${key%.dump*}.sha256" "$tmpdir/" "${extra[@]}" 2>/dev/null || true
    aws s3 cp "${s3prefix%/}/${key%.dump*}.manifest.json" "$tmpdir/" "${extra[@]}" 2>/dev/null || true
    echo "$tmpdir/${key##*/}"
  fi
}

verify_checksums_if_present() {
  local dir file base sumfile
  file="$1"; dir="$(dirname "$file")"; base="$(basename "$file")"
  sumfile="${dir}/${base%.dump*}.sha256"
  if [[ -f "$sumfile" ]]; then
    require_cmd awk
    log "Verifying checksums from $(basename "$sumfile")…"
    # Build a temp sums file only for files we have
    local tmp; tmp="$(mktemp)"
    while read -r sha name; do
      if [[ -f "${dir}/${name}" ]]; then
        echo "${sha}  ${dir}/${name}" >> "$tmp"
      fi
    done < "$sumfile"
    # Use shasum/sha256sum to verify (portable)
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "$tmp"
    else
      sha256sum -c "$tmp"
    fi
    rm -f "$tmp"
    ok "Checksums OK."
  else
    warn "No checksum file adjacent to artifact; skipping verification."
  fi
}

decrypt_if_needed() {
  local file="$1"
  case "$file" in
    *.dump.age)
      require_cmd age
      local out="${file%.age}"
      log "Decrypting age artifact -> $(basename "$out")"
      age -d -o "$out" "$file"
      echo "$out"
      ;;
    *.dump.gpg)
      require_cmd gpg
      local out="${file%.gpg}"
      log "Decrypting gpg artifact -> $(basename "$out")"
      gpg --batch --yes -o "$out" -d "$file"
      echo "$out"
      ;;
    *)
      echo "$file"
      ;;
  esac
}

confirm_or_abort() {
  if [[ "$FORCE" == "1" ]]; then
    warn "Force mode: skipping interactive confirmation."
    return
  fi
  cat <<CONF

You are about to RESTORE into database:
  ${DB_URL}

This may DROP and recreate objects (pg_restore --clean${IF_EXISTS=="1" && echo " --if-exists"}).

Type 'restore' to continue: 
CONF
  read -r ans
  if [[ "$ans" != "restore" ]]; then
    err "Aborted by user."
    exit 1
  fi
}

post_analyze() {
  if [[ "$NO_ANALYZE" == "1" ]]; then
    warn "Skipping ANALYZE (--no-analyze)."
    return
  fi
  log "Running ANALYZE to refresh planner stats…"
  psql "$DB_URL" -v "ON_ERROR_STOP=1" -XtAc "ANALYZE;"
  ok "ANALYZE complete."
}

### ---------- main ----------
main() {
  source_env

  require_cmd pg_restore
  require_cmd jq || warn "jq not found; manifest printing will be limited."

  compose_database_url_if_missing

  [[ "${SKIP_WAIT}" == "1" ]] || wait_for_postgres "${DB_URL}" "${TIMEOUT}"

  # Resolve artifact
  local workdir; workdir="$(mktemp -d)"
  local src="${ARTIFACT:-}"
  if [[ -z "$src" ]]; then
    if [[ -n "$FROM_S3" ]]; then
      src="$(download_latest_from_s3 "$FROM_S3" "$workdir")"
    elif [[ -n "$FROM_DIR" ]]; then
      src="$(pick_latest_local "$FROM_DIR" "$PREFIX")"
    else
      # default to ./backups
      src="$(pick_latest_local "./backups" "$PREFIX")"
    fi
  fi
  [[ -f "$src" ]] || { err "Artifact file not found: $src"; exit 1; }
  log "Using artifact: $src"

  verify_checksums_if_present "$src"

  # Show manifest if present
  local mani="${src%.dump*}.manifest.json"
  if [[ -f "$mani" ]]; then
    log "Manifest (excerpt):"
    if command -v jq >/dev/null 2>&1; then
      jq '{created_at, database, artifact, git}' "$mani" || true
    else
      head -n 20 "$mani" || true
    fi
  fi

  # Decrypt if needed
  local plain; plain="$(decrypt_if_needed "$src")"
  [[ -f "$plain" ]] || { err "Decryption failed or plain artifact missing: $plain"; exit 1; }

  # Safety
  confirm_or_abort

  # Build pg_restore args
  local args=( "--jobs=${JOBS}" "--no-owner" "--no-privileges" "--verbose" )
  if [[ "$CLEAN" == "1" ]]; then args+=( "--clean" ); fi
  if [[ "$IF_EXISTS" == "1" ]]; then args+=( "--if-exists" ); fi
  if [[ "$SCHEMA_ONLY" == "1" ]]; then args+=( "--schema-only" ); fi
  if [[ "$DATA_ONLY" == "1" ]]; then args+=( "--data-only" ); fi
  if [[ -n "$INCLUDE_TABLE" ]]; then args+=( "-t" "$INCLUDE_TABLE" ); fi
  if [[ -n "$EXCLUDE_TABLE" ]]; then args+=( "-T" "$EXCLUDE_TABLE" ); fi

  # Dry run: list contents and exit
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Dry-run: printing archive TOC (no restore)…"
    pg_restore --list "$plain" | sed -n '1,80p'
    ok "Dry-run complete."
    rm -rf "$workdir"; exit 0
  fi

  log "Restoring with pg_restore (jobs=${JOBS})…"
  # Use pg_restore piping to psql so we can honor DATABASE_URL.
  # Alternative is pg_restore -d "$DB_URL" but older versions sometimes mis-parse URIs.
  if ! pg_restore "${args[@]}" --dbname="$DB_URL" "$plain"; then
    err "pg_restore failed."
    exit 1
  fi
  ok "Restore completed."

  post_analyze

  # Cleanup
  rm -rf "$workdir"
  ok "Done."
}

trap 'err "Restore script failed at line $LINENO (exit $?)"' ERR
main "$@"