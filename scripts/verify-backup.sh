#!/usr/bin/env bash
# scripts/verify-backup.sh
#
# Verifies a PostgreSQL logical backup artifact produced by scripts/backup-db.sh.
# Checks:
#   1) Artifact presence (.dump | .dump.age | .dump.gpg)
#   2) Optional checksum verification (.sha256)
#   3) Can decrypt (age/gpg) to a valid pg_dump custom-format archive
#   4) Archive TOC is readable (pg_restore --list)
#   5) Optional FULL verification: restore into an ephemeral Postgres (Docker) and run smoke checks
#
# Usage:
#   scripts/verify-backup.sh
#     [--artifact ./backups/my.dump|.dump.age|.dump.gpg]
#     [--from-dir ./backups --prefix db_app] | [--from-s3 s3://bucket/path/prefix [--use-mc] [--s3-endpoint URL]]
#     [--verify-checksum] [--full] [--docker-image postgres:16-alpine]
#     [--timeout 60] [--keep-container] [--env-file .env] [--dry-run]
#
# Notes:
#  - If no source flags are given, defaults to latest in ./backups
#  - FULL mode needs: docker, pg_restore, psql
#  - Checksum file must sit alongside artifact and be named <artifact>.sha256 (as produced by backup-db.sh)
set -euo pipefail

### ---- styling / logging ----
log()  { printf "\033[1;34m[ verify ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   ok   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  warn  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" 1>&2; }

### ---- defaults / flags ----
ARTIFACT=""
FROM_DIR=""
PREFIX=""
FROM_S3=""
USE_MC="0"
S3_ENDPOINT=""
VERIFY_CHECKSUM="0"
FULL="0"
DOCKER_IMAGE="${PG_VERIFY_IMAGE:-postgres:16-alpine}"
TIMEOUT="60"
KEEP_CONTAINER="0"
ENV_FILE=""
DRY_RUN="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)       ARTIFACT="${2:-}"; shift 2;;
    --from-dir)       FROM_DIR="${2:-}"; shift 2;;
    --prefix)         PREFIX="${2:-}"; shift 2;;
    --from-s3)        FROM_S3="${2:-}"; shift 2;;
    --use-mc)         USE_MC="1"; shift;;
    --s3-endpoint)    S3_ENDPOINT="${2:-}"; shift 2;;
    --verify-checksum) VERIFY_CHECKSUM="1"; shift;;
    --full)           FULL="1"; shift;;
    --docker-image)   DOCKER_IMAGE="${2:-}"; shift 2;;
    --timeout)        TIMEOUT="${2:-}"; shift 2;;
    --keep-container) KEEP_CONTAINER="1"; shift;;
    --env-file)       ENV_FILE="${2:-}"; shift 2;;
    --dry-run)        DRY_RUN="1"; shift;;
    -h|--help)
      sed -n '1,140p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) err "Unknown arg: $1"; exit 2;;
  esac
done

### ---- helpers ----
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command '$1'"; exit 127
  fi
}

sha256_file() {
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
  [[ -n "$prefix" ]] && pattern="${prefix}*.dump ${prefix}*.dump.age ${prefix}*.dump.gpg"
  local latest
  latest="$(ls -1t ${dir}/{${pattern}} 2>/dev/null | head -n1 || true)"
  [[ -n "$latest" ]] || { err "No artifacts found in ${dir} (prefix='${prefix}')"; exit 1; }
  echo "$latest"
}

download_latest_from_s3() {
  local s3prefix="$1" tmpdir="$2"
  mkdir -p "$tmpdir"
  if [[ "$USE_MC" == "1" ]]; then
    require_cmd mc
    log "Finding latest under ${s3prefix} via mc…"
    local newest dumpfile
    newest="$(mc ls "${s3prefix%/}"/ | awk '{print $6}' | sort | tail -n1)"
    [[ -n "$newest" ]] || { err "No subfolders under ${s3prefix}"; exit 1; }
    mc cp -r "${s3prefix%/}/${newest}" "$tmpdir/"
    dumpfile="$(ls -1t "$tmpdir/$newest"/*.dump* | head -n1)"
    [[ -f "$dumpfile" ]] || { err "No *.dump* found in ${newest}"; exit 1; }
    # best-effort checksum & manifest
    cp "${dumpfile%.dump*}.sha256" "$tmpdir/" 2>/dev/null || true
    cp "${dumpfile%.dump*}.manifest.json" "$tmpdir/" 2>/dev/null || true
    echo "$dumpfile"
  else
    require_cmd aws
    local extra=()
    [[ -n "$S3_ENDPOINT" ]] && extra+=( --endpoint-url "$S3_ENDPOINT" )
    log "Finding latest under ${s3prefix} via aws s3…"
    local key
    key="$(aws s3 ls "${s3prefix%/}/" "${extra[@]}" \
      | awk '{print $4}' | egrep '\.dump(\.age|\.gpg)?$' | sort | tail -n1)"
    [[ -n "$key" ]] || { err "No artifacts beneath ${s3prefix}"; exit 1; }
    aws s3 cp "${s3prefix%/}/${key}" "$tmpdir/" "${extra[@]}"
    aws s3 cp "${s3prefix%/}/${key%.dump*}.sha256" "$tmpdir/" "${extra[@]}" 2>/dev/null || true
    aws s3 cp "${s3prefix%/}/${key%.dump*}.manifest.json" "$tmpdir/" "${extra[@]}" 2>/dev/null || true
    echo "$tmpdir/${key##*/}"
  fi
}

verify_checksum_if_requested() {
  local file="$1"
  [[ "$VERIFY_CHECKSUM" == "1" ]] || { warn "Checksum verification disabled (--verify-checksum not set)."; return; }
  local sumfile="${file%.dump*}.sha256"
  [[ -f "$sumfile" ]] || { err "Checksum file missing: $(basename "$sumfile")"; exit 1; }
  log "Verifying SHA-256 for $(basename "$file")…"
  local actual expected
  actual="$(sha256_file "$file")"
  # the .sha256 may contain multiple lines; find the matching one
  expected="$(awk -v n="$(basename "$file")" '$2==n{print $1}' "$sumfile" | head -n1)"
  [[ -n "$expected" ]] || expected="$(awk '{print $1; exit}' "$sumfile")"
  if [[ "$actual" != "$expected" ]]; then
    err "Checksum mismatch! expected=${expected:-<none>} actual=$actual"
    exit 1
  fi
  ok "Checksum OK."
}

decrypt_if_needed() {
  local file="$1"
  case "$file" in
    *.dump.age)
      require_cmd age
      local out="${file%.age}"
      log "Decrypting age -> $(basename "$out")"
      age -d -o "$out" "$file"
      echo "$out"
      ;;
    *.dump.gpg)
      require_cmd gpg
      local out="${file%.gpg}"
      log "Decrypting gpg -> $(basename "$out")"
      gpg --batch --yes -o "$out" -d "$file"
      echo "$out"
      ;;
    *)
      echo "$file"
      ;;
  esac
}

toc_smoke_test() {
  local file="$1"
  require_cmd pg_restore
  log "Reading archive TOC (pg_restore --list)…"
  pg_restore --list "$file" | head -n 20 >/dev/null
  ok "Archive TOC readable."
}

full_restore_ephemeral() {
  local file="$1" timeout="$2" image="$3" keep="$4"
  require_cmd docker
  require_cmd pg_restore
  require_cmd psql

  local cname="pg-verify-$$"
  local pw="verify_pw"
  local db="verify_db"
  local url="postgresql://postgres:${pw}@127.0.0.1:55432/${db}?sslmode=disable"

  log "Starting ephemeral Postgres (${image}) container '${cname}'…"
  docker run -d --rm --name "$cname" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB="$db" -p 55432:5432 "$image" >/dev/null

  # wait for ready
  log "Waiting for Postgres to be ready (timeout ${timeout}s)…"
  local start now
  start="$(date +%s)"
  until psql "$url" -XtAc "select 1" >/dev/null 2>&1; do
    now="$(date +%s)"
    if (( now - start > timeout )); then
      docker logs "$cname" || true
      [[ "$keep" == "1" ]] || docker stop "$cname" >/dev/null || true
      err "Timed out waiting for ephemeral Postgres."
      exit 1
    fi
    sleep 2
  done
  ok "Ephemeral Postgres ready."

  log "Restoring archive into ephemeral DB…"
  if ! pg_restore --jobs=4 --no-owner --no-privileges --verbose --dbname="$url" "$file"; then
    docker logs "$cname" || true
    [[ "$keep" == "1" ]] || docker stop "$cname" >/dev/null || true
    err "pg_restore failed during FULL verification."
    exit 1
  fi
  ok "Restore succeeded."

  log "Running smoke checks (ANALYZE)…"
  psql "$url" -XtAc "ANALYZE;" >/dev/null || true

  if [[ "$keep" == "1" ]]; then
    warn "Keeping container '${cname}' as requested (--keep-container)."
  else
    docker stop "$cname" >/dev/null || true
    ok "Ephemeral Postgres stopped."
  fi
}

### ---- main ----
main() {
  # Optional env-file (for decryption keys, AWS env, etc.)
  if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || { err "--env-file not found: $ENV_FILE"; exit 1; }
    log "Loading env from ${ENV_FILE}"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
  fi

  local workdir; workdir="$(mktemp -d)"
  local src="${ARTIFACT:-}"

  if [[ -z "$src" ]]; then
    if [[ -n "$FROM_S3" ]]; then
      src="$(download_latest_from_s3 "$FROM_S3" "$workdir")"
    elif [[ -n "$FROM_DIR" ]]; then
      src="$(pick_latest_local "$FROM_DIR" "$PREFIX")"
    else
      src="$(pick_latest_local "./backups" "$PREFIX")"
    fi
  fi

  [[ -f "$src" ]] || { err "Artifact not found: $src"; exit 1; }
  log "Using artifact: $src"

  verify_checksum_if_requested "$src"

  # Try to show manifest if present
  local mani="${src%.dump*}.manifest.json"
  if [[ -f "$mani" ]]; then
    if command -v jq >/dev/null 2>&1; then
      log "Manifest summary:"
      jq '{created_at,artifact,database,git}' "$mani" || true
    else
      log "Manifest (first 20 lines):"; head -n 20 "$mani" || true
    fi
  else
    warn "No manifest found (optional)."
  fi

  local plain; plain="$(decrypt_if_needed "$src")"
  [[ -f "$plain" ]] || { err "Decryption failed or plain archive missing: $plain"; exit 1; }

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Dry-run: printing TOC excerpt…"
    require_cmd pg_restore
    pg_restore --list "$plain" | sed -n '1,60p'
    ok "Dry-run TOC printed."
    rm -rf "$workdir"; exit 0
  fi

  toc_smoke_test "$plain"

  if [[ "$FULL" == "1" ]]; then
    full_restore_ephemeral "$plain" "$TIMEOUT" "$DOCKER_IMAGE" "$KEEP_CONTAINER"
  else
    warn "FULL restore not requested; basic verification only. Use --full for deep validation."
  fi

  ok "Verification completed successfully."
  rm -rf "$workdir"
}

trap 'err "Verification failed at line $LINENO (exit $?)"' ERR
main "$@"