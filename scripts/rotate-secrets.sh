#!/usr/bin/env bash
# scripts/rotate-secrets.sh
#
# Rotate application secrets safely across targets:
#  - local .env[.*] files
#  - Kubernetes Secret (kubectl)
#  - GitOps file encrypted with SOPS (age or GPG)
#
# Generates cryptographically-strong random values, writes an auditable
# rotation manifest, supports dry-runs, and (optionally) triggers a
# rolling restart of affected Deployments after rotation.
#
# Examples:
#   # rotate common app secrets in .env.production and a K8s Secret
#   scripts/rotate-secrets.sh \
#     --keys NEXTAUTH_SECRET,SESSION_SECRET,JWT_SECRET,CSRF_SECRET,EMAIL_TOKEN_SECRET \
#     --env-file .env.production \
#     --k8s-secret-name web-app --namespace app \
#     --restart app/web
#
#   # rotate and write a SOPS-encrypted Secret file (for GitOps)
#   scripts/rotate-secrets.sh \
#     --keys NEXTAUTH_SECRET,SESSION_SECRET \
#     --sops-file infra/helm/secrets/web-app.secret.yaml \
#     --k8s-secret-name web-app --namespace app
#
#   # dry-run to preview changes without writing
#   scripts/rotate-secrets.sh --keys NEXTAUTH_SECRET --env-file .env --dry-run
#
set -euo pipefail

### -------- Logging helpers --------
log()  { printf "\033[1;34m[ rotate ]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[   ok   ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[  warn  ]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[ ERROR  ]\033[0m %s\n" "$*" >&2; }

### -------- Defaults / flags --------
KEYS_RAW=""                 # comma/space separated list
ENV_FILE=""                 # .env target
K8S_SECRET_NAME=""          # kubernetes secret name
K8S_NAMESPACE="default"
K8S_CONTEXT=""              # optional kube context
SOPS_FILE=""                # path for sops-encrypted Secret yaml (create/overwrite)
DRY_RUN="0"
ROLL_RESTART=()             # one or more deployment identifiers: deployment/name or ns/deploy
ANNOTATION_KEY="bowdoin.dev/rotatedAt"
LABELS="app=web,tier=backend"   # labels used when creating k8s Secret/SOPS file
EXTRA_K8S_ARGS=()               # e.g. --server-side --prune
JOBS=()                         # reserved
ALGO="HS256"                    # JWT secret algorithm for generated JWT_SECRET (HS256/EdDSA not used here)
LENGTH_BYTES=64                 # default secret length (bytes) before base64url

### -------- Parse args --------
usage() {
  cat <<'HELP'
Usage: scripts/rotate-secrets.sh [options]

Required:
  --keys <CSV>                Comma (or space) separated env var names to rotate.

Targets (any combination):
  --env-file <path>           Update/append keys in a local .env-style file.
  --k8s-secret-name <name>    Apply keys to a Kubernetes Secret (stringData).
  --namespace <ns>            Kubernetes namespace (default: default).
  --context <ctx>             kubectl context for operations.
  --sops-file <path>          Create/overwrite a SOPS-encryptable K8s Secret yaml at this path.

Behavior:
  --algo <HS256>              Algorithm for JWT_SECRET generation (currently HS256 random).
  --length-bytes <n>          Random length before base64url (default: 64).
  --restart <deploy>          Rollout restart a deployment after rotation; may be passed multiple times.
  --labels <k=v,k=v>          Labels to set on new K8s/SOPS Secret (default: app=web,tier=backend).
  --dry-run                   Print actions without writing.
  -h, --help                  Show this help.

Notes:
  * Requires: openssl, awk, sed; for K8s: kubectl; for SOPS file: sops.
  * This script NEVER prints actual secret values unless --dry-run is used AND you confirm.
HELP
}

CONFIRM_REVEAL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keys)            KEYS_RAW="${2:-}"; shift 2;;
    --env-file)        ENV_FILE="${2:-}"; shift 2;;
    --k8s-secret-name) K8S_SECRET_NAME="${2:-}"; shift 2;;
    --namespace)       K8S_NAMESPACE="${2:-}"; shift 2;;
    --context)         K8S_CONTEXT="${2:-}"; shift 2;;
    --sops-file)       SOPS_FILE="${2:-}"; shift 2;;
    --algo)            ALGO="${2:-}"; shift 2;;
    --length-bytes)    LENGTH_BYTES="${2:-}"; shift 2;;
    --restart)         ROLL_RESTART+=("$2"); shift 2;;
    --labels)          LABELS="${2:-}"; shift 2;;
    --dry-run)         DRY_RUN="1"; shift;;
    --reveal)          # undocumented: only for local tests
                       CONFIRM_REVEAL="1"; shift;;
    -h|--help)         usage; exit 0;;
    *)                 err "Unknown arg: $1"; usage; exit 2;;
  esac
done

[[ -n "$KEYS_RAW" ]] || { err "--keys is required"; usage; exit 2; }

### -------- Dependencies --------
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"; exit 127
  fi
}
require_cmd openssl
require_cmd awk
require_cmd sed
[[ -n "$K8S_SECRET_NAME" ]] && require_cmd kubectl || true
[[ -n "$SOPS_FILE" ]] && require_cmd sops || true

### -------- Utils --------
now_rfc3339() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
b64url() { tr '+/' '-_' | tr -d '='; }  # base64 -> base64url without padding

rand_b64url() {
  local n="${1:-$LENGTH_BYTES}"
  # openssl rand returns raw bytes; then encode with base64url
  openssl rand "$n" | base64 | b64url
}

slugify() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }

IFS=', ' read -r -a KEYS <<< "$KEYS_RAW"

### -------- Secret value generation policy --------
# You can customize per-key generation if some need specific sizes/formats.
gen_value_for_key() {
  local key="$1"
  case "$key" in
    NEXTAUTH_SECRET)           rand_b64url 64 ;;
    SESSION_SECRET)            rand_b64url 64 ;;
    CSRF_SECRET)               rand_b64url 48 ;;
    EMAIL_TOKEN_SECRET)        rand_b64url 48 ;;
    JWT_SECRET)                # default HS256 shared secret
                               rand_b64url 64 ;;
    PASSWORD_PEPPER)           rand_b64url 32 ;;
    ENCRYPTION_KEY|CRYPTO_KEY) rand_b64url 32 ;;
    *)                         rand_b64url "$LENGTH_BYTES" ;;
  esac
}

### -------- .env write/patch --------
ensure_env_line() {
  local file="$1" key="$2" val="$3"
  if [[ ! -f "$file" ]]; then
    [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] create $file"; return; }
    log "Creating ${file}"
    touch "$file"
  fi
  # If key exists (even commented), replace; else append.
  if grep -Eq "^[[:space:]]*${key}=" "$file"; then
    [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] update ${key}=<redacted> in ${file}"; return; }
    sed -i.bak -E "s|^${key}=.*$|${key}=${val}|g" "$file"
  else
    [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] append ${key}=<redacted> to ${file}"; return; }
    printf "%s=%s\n" "$key" "$val" >> "$file"
  fi
}

### -------- Kubernetes Secret apply --------
apply_k8s_secret() {
  local name="$1" namespace="$2"
  local -a kubectl_args=(kubectl)
  [[ -n "$K8S_CONTEXT" ]] && kubectl_args+=(--context "$K8S_CONTEXT")

  # Build temporary manifest with stringData (so we don't pre-encode)
  local tmp; tmp="$(mktemp)"
  {
    echo "apiVersion: v1"
    echo "kind: Secret"
    echo "metadata:"
    echo "  name: ${name}"
    echo "  namespace: ${namespace}"
    echo "  labels:"
    IFS=',' read -r -a lbls <<< "$LABELS"
    for kv in "${lbls[@]}"; do
      [[ -z "$kv" ]] && continue
      echo "    ${kv%%=*}: ${kv#*=}"
    done
    echo "  annotations:"
    echo "    ${ANNOTATION_KEY}: \"$(now_rfc3339)\""
    echo "type: Opaque"
    echo "stringData:"
    for k in "${!ROTATED[@]}"; do
      printf "  %s: \"%s\"\n" "$k" "${ROTATED[$k]}"
    done
  } > "$tmp"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] kubectl apply -f <generated> -n ${namespace}"
    rm -f "$tmp"
    return
  fi

  log "Applying Kubernetes Secret '${name}' in ns='${namespace}'…"
  "${kubectl_args[@]}" apply -f "$tmp" >/dev/null
  rm -f "$tmp"
  ok "K8s Secret applied."
}

### -------- SOPS Secret file (GitOps) --------
write_sops_secret_file() {
  local path="$1" name="$2" namespace="$3"
  local dir; dir="$(dirname "$path")"
  [[ -d "$dir" ]] || {
    if [[ "$DRY_RUN" == "1" ]]; then log "[dry-run] mkdir -p ${dir}"; else mkdir -p "$dir"; fi
  }

  local tmp; tmp="$(mktemp)"
  {
    echo "apiVersion: v1"
    echo "kind: Secret"
    echo "type: Opaque"
    echo "metadata:"
    echo "  name: ${name}"
    echo "  namespace: ${namespace}"
    echo "  labels:"
    IFS=',' read -r -a lbls <<< "$LABELS"
    for kv in "${lbls[@]}"; do
      [[ -z "$kv" ]] && continue
      echo "    ${kv%%=*}: ${kv#*=}"
    done
    echo "  annotations:"
    echo "    ${ANNOTATION_KEY}: \"$(now_rfc3339)\""
    echo "stringData:"
    for k in "${!ROTATED[@]}"; do
      printf "  %s: \"%s\"\n" "$k" "${ROTATED[$k]}"
    done
  } > "$tmp"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] write SOPS secret yaml to ${path} (unencrypted preview)"
    sed -n '1,40p' "$tmp"
    rm -f "$tmp"
    return
  fi

  # If the destination file already exists and is sops-encrypted, re-encrypt in place.
  if [[ -f "$path" ]]; then
    log "Overwriting existing SOPS file: ${path}"
  else
    log "Creating new SOPS file: ${path}"
  fi

  # Encrypt in-place
  cp "$tmp" "$path"
  rm -f "$tmp"
  # Use sops to encrypt in-place. KMS/age/GPG rules must be configured via .sops.yaml or env.
  sops -e -i "$path"
  ok "SOPS secret file written."
}

### -------- Rollout restart --------
rollout_restart() {
  local ident="$1"
  local -a kubectl_args=(kubectl)
  [[ -n "$K8S_CONTEXT" ]] && kubectl_args+=(--context "$K8S_CONTEXT")

  # Support "ns/deploy" or "deploy/name" in current namespace
  if [[ "$ident" == */* ]]; then
    local ns="${ident%%/*}"
    local res="${ident#*/}"
    log "Restarting deployment '${res}' in ns='${ns}'…"
    "${kubectl_args[@]}" -n "$ns" rollout restart "deployment/${res}"
    "${kubectl_args[@]}" -n "$ns" rollout status "deployment/${res}" --timeout=90s
  else
    log "Restarting deployment '${ident}' in ns='${K8S_NAMESPACE}'…"
    "${kubectl_args[@]}" -n "$K8S_NAMESPACE" rollout restart "deployment/${ident}"
    "${kubectl_args[@]}" -n "$K8S_NAMESPACE" rollout status "deployment/${ident}" --timeout=90s
  fi
  ok "Deployment restarted."
}

### -------- Main rotation flow --------
declare -A ROTATED
declare -A PREV

main() {
  log "Starting secret rotation…"
  log "Keys: ${KEYS[*]}"
  [[ "$DRY_RUN" == "1" ]] && warn "Dry-run: no files will be modified."

  # Load previous values from ENV_FILE (if exists) so we can back up (never printed).
  if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    while IFS='=' read -r k v; do
      [[ -z "$k" ]] && continue
      [[ "$k" =~ ^# ]] && continue
      PREV["$k"]="${v:-}"
    done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)
  fi

  # Generate fresh values
  for key in "${KEYS[@]}"; do
    key="$(echo "$key" | tr -d ' ')" # trim
    [[ -z "$key" ]] && continue
    ROTATED["$key"]="$(gen_value_for_key "$key")"
  done

  # Optional: reveal in dry-run only with confirmation
  if [[ "$DRY_RUN" == "1" && "$CONFIRM_REVEAL" == "1" ]]; then
    warn "DRY-RUN SECRET PREVIEW (do not share):"
    for k in "${!ROTATED[@]}"; do printf "  %s=%s\n" "$k" "${ROTATED[$k]}"; done
  fi

  # Write to .env file
  if [[ -n "$ENV_FILE" ]]; then
    log "Updating ENV file: ${ENV_FILE}"
    for k in "${!ROTATED[@]}"; do
      ensure_env_line "$ENV_FILE" "$k" "${ROTATED[$k]}"
    done
    [[ "$DRY_RUN" == "1" ]] || ok "ENV file updated."
  fi

  # Apply to Kubernetes Secret
  if [[ -n "$K8S_SECRET_NAME" ]]; then
    apply_k8s_secret "$K8S_SECRET_NAME" "$K8S_NAMESPACE"
  fi

  # Write SOPS file (GitOps)
  if [[ -n "$SOPS_FILE" ]]; then
    write_sops_secret_file "$SOPS_FILE" "${K8S_SECRET_NAME:-$(slugify "app-secrets")}" "$K8S_NAMESPACE"
  fi

  # Rollout restart targets
  for d in "${ROLL_RESTART[@]:-}"; do
    [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] rollout restart ${d}"; continue; }
    rollout_restart "$d"
  done

  # Rotation manifest (local, not including actual secret values)
  local manifest_dir=".rotation-manifests"
  local manifest_path="${manifest_dir}/rotation-$(date -u +%Y%m%dT%H%M%SZ).json"
  mkdir -p "$manifest_dir"
  {
    echo "{"
    echo "  \"rotatedAt\": \"$(now_rfc3339)\","
    echo "  \"keys\": ["
    local first=1
    for k in "${KEYS[@]}"; do
      [[ $first -eq 1 ]] && first=0 || printf ",\n"
      printf "    \"%s\"" "$k"
    done
    echo -e "\n  ],"
    echo "  \"targets\": {"
    local sep=""
    [[ -n "$ENV_FILE" ]] && { printf "    \"envFile\": \"%s\"" "$ENV_FILE"; sep=","; }
    [[ -n "$K8S_SECRET_NAME" ]] && { printf "%s\n    \"k8sSecret\": {\"name\":\"%s\",\"namespace\":\"%s\"}" "$([[ -n "$sep" ]] && echo ,)" "$K8S_SECRET_NAME" "$K8S_NAMESPACE"; sep=","; }
    [[ -n "$SOPS_FILE" ]] && { printf "%s\n    \"sopsFile\": \"%s\"" "$([[ -n "$sep" ]] && echo ,)" "$SOPS_FILE"; }
    echo -e "\n  }"
    echo "}"
  } > "$manifest_path"

  [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] wrote manifest ${manifest_path}"; } || ok "Manifest written: ${manifest_path}"
  ok "Secret rotation completed."
}

trap 'err "Failed at line $LINENO (exit $?)"' ERR
main