#!/usr/bin/env bash
# scripts/backup-db.sh
#
# Production-grade PostgreSQL logical backup script.
#
# Features
# - Reads DATABASE_URL or DB_* pieces
# - Waits for DB to be reachable (optional --skip-wait)
# - pg_dump in custom format (-Fc), max compression (-Z 9), blobs included
# - Optional table include/exclude globs
# - SHA256 checksum + manifest.json
# - Local retention by count or days
# - Uploads to S3/MinIO via awscli (or mc) with server-side encryption (if configured)
# - Optional client-side encryption via age or gpg
# - Smoke-verify backup with pg_restore --list
#
# Usage:
#   scripts/backup-db.sh [--env-file .env] [--out-dir ./backups]
#                        [--prefix bowdoin-marketplace]
#                        [--include 'public.*'] [--exclude 'audit_logs*']
#                        [--timeout 60] [--skip-wait]
#                        [--age-recipient <agepub>|--gpg-recipient <fpr>]
#                        [--s3-bucket s3://bucket/path] [--s3-kms-id <kms-arn>]
#                        [--s3-sse AES256|aws:kms] [--s3-endpoint https://minio:9000]
#                        [--retention-days 7|--retention-count 14]
#                        [--use-mc]  # upload with 'mc' instead of 'aws s3'
#
# Environment:
#   DATABASE_URL or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) if using S3
#   AWS_DEFAULT_REGION (defaults to us-east-1)
#   MC_HOST_minio (if using 'mc', e.g. https://KEY:SECRET@minio:9000)
#
set -euo pipefail

### ---------- logging ----------
log()  { printf "\033[1;34m[ backup ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   ok   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  warn  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" 1>&2; }

### ---------- defaults ----------
ENV_FILE=""
OUT_DIR="./backups"
PREFIX="db"
TIMEOUT="60"
SKIP_WAIT="0"
INCLUDE_TABLE=""
EXCLUDE_TABLE=""
AGE_RECIPIENT=""
GPG_RECIPIENT=""
S3_BUCKET=""
S3_ENDPOINT=""
S3_SSE=""          # AES256 | aws:kms
S3_KMS_ID=""
RETENTION_DAYS=""
RETENTION_COUNT=""
USE_MC="0"

### ---------- args ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)        ENV_FILE="${2:-}"; shift 2;;
    --out-dir)         OUT_DIR="${2:-}"; shift 2;;
    --prefix)          PREFIX="${2:-}"; shift 2;;
    --include)         INCLUDE_TABLE="${2:-}"; shift 2;;
    --exclude)         EXCLUDE_TABLE="${2:-}"; shift 2;;
    --timeout)         TIMEOUT="${2:-}"; shift 2;;
    --skip-wait)       SKIP_WAIT="1"; shift;;
    --age-recipient)   AGE_RECIPIENT="${2:-}"; shift 2;;
    --gpg-recipient)   GPG_RECIPIENT="${2:-}"; shift 2;;
    --s3-bucket)       S3_BUCKET="${2:-}"; shift 2;;
    --s3-endpoint)     S3_ENDPOINT="${2:-}"; shift 2;;
    --s3-sse)          S3_SSE="${2:-}"; shift 2;;
    --s3-kms-id)       S3_KMS_ID="${2:-}"; shift 2;;
    --retention-days)  RETENTION_DAYS="${2:-}"; shift 2;;
    --retention-count) RETENTION_COUNT="${2:-}"; shift 2;;
    --use-mc)          USE_MC="1"; shift;;
    -h|--help)
      sed -n '1,120p' "$0" | sed 's/^# \{0,1\}//'
      exit 0;;
    *) err "Unknown arg: $1"; exit 2;;
  esac
done

### ---------- helpers ----------
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command '$1'."
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
  if [[ -z "${DATABASE_URL:-}" ]]; then
    if [[ -n "${DB_HOST:-}" && -n "${DB_PORT:-}" && -n "${DB_USER:-}" && -n "${DB_NAME:-}" ]]; then
      local pass_part=""
      if [[ -n "${DB_PASSWORD:-}" ]]; then pass_part=":${DB_PASSWORD}"; fi
      export DATABASE_URL="postgresql://${DB_USER}${pass_part}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
      warn "DATABASE_URL not set; composed from DB_* -> ${DATABASE_URL}"
    else
      err "DATABASE_URL not set and DB_* vars are insufficient."
      exit 1
    fi
  fi
}

wait_for_postgres() {
  local url="$1" timeout="$2" start now
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

### ---------- main ----------
main() {
  source_env

  require_cmd pg_dump
  require_cmd pg_restore
  require_cmd psql
  require_cmd jq
  require_cmd tar
  require_cmd gzip

  compose_database_url_if_missing
  export DATABASE_URL

  [[ -d "${OUT_DIR}" ]] || mkdir -p "${OUT_DIR}"

  if [[ "${SKIP_WAIT}" != "1" ]]; then
    wait_for_postgres "${DATABASE_URL}" "${TIMEOUT}"
  else
    warn "Skipping DB readiness check (--skip-wait)."
  fi

  # Build filename components
  local ts dbname host parsed_db
  ts="$(date -u +"%Y%m%dT%H%M%SZ")"
  # Extract db name for nicer filenames
  parsed_db="$(psql "${DATABASE_URL}" -Atc "select current_database()" 2>/dev/null || true)"
  dbname="${parsed_db:-db}"
  host="$(psql "${DATABASE_URL}" -Atc "select inet_server_addr()" 2>/dev/null || echo "db")"

  local base="${PREFIX}_${dbname}_${ts}"
  local dump_path="${OUT_DIR}/${base}.dump"
  local enc_path=""  # if encrypted we’ll set this
  local manifest="${OUT_DIR}/${base}.manifest.json"
  local checksum_file="${OUT_DIR}/${base}.sha256"

  # Build pg_dump args
  # -Fc custom format, -Z9 compress, --blobs for large objects, --no-owner for portability
  local args=( "--format=custom" "-Z" "9" "--blobs" "--no-owner" "--no-acl" "--verbose" )
  # Optional include/exclude (globs accepted by pg_dump with -t/-T)
  if [[ -n "${INCLUDE_TABLE}" ]]; then args+=( "-t" "${INCLUDE_TABLE}" ); fi
  if [[ -n "${EXCLUDE_TABLE}" ]]; then args+=( "-T" "${EXCLUDE_TABLE}" ); fi

  log "Running pg_dump…"
  # pg_dump accepts connection string directly
  if ! pg_dump "${DATABASE_URL}" "${args[@]}" -f "${dump_path}"; then
    err "pg_dump failed."
    exit 1
  fi

  ok "Dump created: ${dump_path}"

  # Quick smoke test: can pg_restore list?
  log "Verifying dump integrity with pg_restore --list…"
  if ! pg_restore --list "${dump_path}" >/dev/null; then
    err "pg_restore list failed; backup may be corrupt."
    exit 1
  fi
  ok "Dump integrity looks good."

  # Optional client-side encryption
  if [[ -n "${AGE_RECIPIENT}" && -n "${GPG_RECIPIENT}" ]]; then
    err "Choose only one encryption method: --age-recipient OR --gpg-recipient."
    exit 2
  fi

  if [[ -n "${AGE_RECIPIENT}" ]]; then
    require_cmd age
    enc_path="${dump_path}.age"
    log "Encrypting with age (recipient: ${AGE_RECIPIENT})…"
    age -r "${AGE_RECIPIENT}" -o "${enc_path}" "${dump_path}"
    rm -f "${dump_path}"
    dump_path="${enc_path}"
    ok "Encrypted -> ${dump_path}"
  elif [[ -n "${GPG_RECIPIENT}" ]]; then
    require_cmd gpg
    enc_path="${dump_path}.gpg"
    log "Encrypting with gpg (recipient: ${GPG_RECIPIENT})…"
    gpg --batch --yes --trust-model always -o "${enc_path}" -r "${GPG_RECIPIENT}" -e "${dump_path}"
    rm -f "${dump_path}"
    dump_path="${enc_path}"
    ok "Encrypted -> ${dump_path}"
  fi

  # Create manifest (add repo metadata if available)
  local git_sha git_branch
  if command -v git >/dev/null 2>&1; then
    git_sha="$(git rev-parse --short HEAD 2>/dev/null || true)"
    git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  else
    git_sha="unknown"
    git_branch="unknown"
  fi

  # Include Prisma migrations bundle for convenience
  local mig_tar="${OUT_DIR}/${base}.migrations.tar.gz"
  if [[ -d "packages/db/prisma/migrations" ]]; then
    log "Archiving Prisma migrations…"
    tar -C packages/db/prisma -czf "${mig_tar}" migrations >/dev/null 2>&1 || true
  fi

  log "Writing manifest…"
  jq -n \
    --arg when "${ts}" \
    --arg db "${dbname}" \
    --arg host "${host}" \
    --arg file "$(basename "${dump_path}")" \
    --arg git_sha "${git_sha}" \
    --arg git_branch "${git_branch}" \
    --arg format "pg_dump:custom" \
    --arg include "${INCLUDE_TABLE}" \
    --arg exclude "${EXCLUDE_TABLE}" \
    --arg prisma_migrations "$(basename "${mig_tar}")" \
    '{
      created_at: $when,
      database: $db,
      host: $host,
      artifact: $file,
      format: $format,
      include_table: $include,
      exclude_table: $exclude,
      git: { sha: $git_sha, branch: $git_branch },
      extras: { prisma_migrations: $prisma_migrations }
    }' > "${manifest}"

  # Checksums
  log "Computing checksums…"
  local dump_sha manifest_sha mig_sha
  dump_sha="$(sha256 "${dump_path}")"
  manifest_sha="$(sha256 "${manifest}")"
  echo "${dump_sha}  $(basename "${dump_path}")" > "${checksum_file}"
  echo "${manifest_sha}  $(basename "${manifest}")" >> "${checksum_file}"
  if [[ -f "${mig_tar}" ]]; then
    mig_sha="$(sha256 "${mig_tar}")"
    echo "${mig_sha}  $(basename "${mig_tar}")" >> "${checksum_file}"
  fi
  ok "Checksums -> ${checksum_file}"

  # Upload to S3/MinIO if configured
  if [[ -n "${S3_BUCKET}" ]]; then
    if [[ "${USE_MC}" == "1" ]]; then
      require_cmd mc
      # Expect user to have configured 'mc alias set minio <endpoint> <key> <secret>'
      # Or provided MC_HOST_* envs.
      local target="${S3_BUCKET%/}/${PREFIX}/${dbname}/${ts}"
      log "Uploading via mc to ${target}…"
      mc cp "${dump_path}"    "${target}/"
      mc cp "${manifest}"     "${target}/"
      [[ -f "${mig_tar}" ]]   && mc cp "${mig_tar}" "${target}/"
      mc cp "${checksum_file}" "${target}/"
      ok "Upload (mc) complete."
    else
      require_cmd aws
      export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
      local extra_opts=()
      if [[ -n "${S3_ENDPOINT}" ]]; then
        extra_opts+=( "--endpoint-url" "${S3_ENDPOINT}" )
      fi
      if [[ -n "${S3_SSE}" ]]; then
        extra_opts+=( "--sse" "${S3_SSE}" )
      fi
      if [[ -n "${S3_KMS_ID}" ]]; then
        extra_opts+=( "--sse-kms-key-id" "${S3_KMS_ID}" )
      fi

      local s3_prefix="${S3_BUCKET%/}/${PREFIX}/${dbname}/${ts}"
      log "Uploading to ${s3_prefix}…"
      aws s3 cp "${dump_path}"     "${s3_prefix}/" "${extra_opts[@]}"
      aws s3 cp "${manifest}"      "${s3_prefix}/" "${extra_opts[@]}"
      [[ -f "${mig_tar}" ]] && aws s3 cp "${mig_tar}" "${s3_prefix}/" "${extra_opts[@]}"
      aws s3 cp "${checksum_file}" "${s3_prefix}/" "${extra_opts[@]}"
      ok "Upload complete."
    fi
  else
    warn "S3 bucket not set; backup kept locally at ${OUT_DIR}"
  fi

  # Local retention (best-effort)
  apply_retention

  ok "Backup finished: $(basename "${dump_path}")"
}

apply_retention() {
  # Retention by days
  if [[ -n "${RETENTION_DAYS}" ]]; then
    log "Applying retention by age: > ${RETENTION_DAYS} days"
    # find backup families by prefix
    find "${OUT_DIR}" -type f -name "${PREFIX}_*.{dump,dump.age,dump.gpg,manifest.json,sha256,migrations.tar.gz}" -mtime +"${RETENTION_DAYS}" -print0 2>/dev/null \
      | xargs -0r rm -f || true
  fi

  # Retention by count (keep N most recent families)
  if [[ -n "${RETENTION_COUNT}" ]]; then
    log "Applying retention by count: keep ${RETENTION_COUNT} most recent families"
    # List base names without extensions, sorted newest first
    mapfile -t families < <(ls -1 "${OUT_DIR}/${PREFIX}"_* 2>/dev/null \
      | sed -E 's/\.(dump|dump\.age|dump\.gpg|manifest\.json|sha256|migrations\.tar\.gz)$//' \
      | xargs -I{} basename "{}" \
      | sort -u | sort -r)
    local idx=0
    for fam in "${families[@]}"; do
      (( idx++ ))
      if (( idx > RETENTION_COUNT )); then
        # remove all files with this family base
        rm -f "${OUT_DIR}/${fam}.dump" \
              "${OUT_DIR}/${fam}.dump.age" \
              "${OUT_DIR}/${fam}.dump.gpg" \
              "${OUT_DIR}/${fam}.manifest.json" \
              "${OUT_DIR}/${fam}.sha256" \
              "${OUT_DIR}/${fam}.migrations.tar.gz" || true
      fi
    done
  fi
}

trap 'err "Backup script failed at line $LINENO (exit $?)"' ERR
main "$@"