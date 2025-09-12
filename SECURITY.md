# Security Policy

We take the security of this project and our users seriously. Thank you for responsibly disclosing any vulnerabilities you find.

---

## Report a Vulnerability

- **Primary contact (security):** security@your-org.example
- **Backup contact:** engineering@your-org.example
- **PGP key (optional, recommended):**
  - Fingerprint: `AAAA BBBB CCCC DDDD EEEE FFFF 1111 2222 3333 4444`
  - Public key: see `docs/pgp/SECURITY.asc` (or request by email)

Please include:
- A clear description of the issue and potential impact
- Step-by-step reproduction instructions (PoC preferred)
- Affected components / paths (e.g., `apps/web`, `packages/auth`, `infra/helm/...`)
- Any logs, screenshots, or network traces
- Your environment (OS, browser, versions)

**Do not** exfiltrate data, escalate beyond minimally necessary proofs, or degrade service availability.

We aim to acknowledge reports **within 2 business days** and provide triage status **within 5 business days**.

---

## Coordinated Disclosure & Safe Harbor

We follow responsible disclosure best practices:

- Please allow us **up to 90 days** to remediate before public disclosure (expedited timelines welcome where risk is high and fix is straightforward).
- We will keep you informed about progress and planned timelines.
- If you follow this policy, we will not pursue or support legal action against you for good-faith research, including:
  - Accidental access to a small amount of data (report and delete immediately)
  - Circumventing technical measures to the extent strictly necessary to demonstrate the vulnerability
  - Creating or using test accounts

Out of scope for testing:
- Social engineering of employees/users
- Physical attacks or threats
- DDoS/volumetric attacks or spam
- Automated scanning that materially impacts availability
- Third-party services where we do not own the program (report to the vendor)

---

## Scope

This policy covers **all code and assets in this repository** and our default deployment manifests:

- `apps/web` (Next.js app & API routes)
- `packages/*` (auth, queue, email, storage, db, security, observability, rate-limit, utils, config, contracts)
- `infra/helm/**` charts (app, postgres, redis, minio, otel-collector, prometheus-stack)
- CI/CD workflows in `.github/workflows/**`
- Operational scripts in `scripts/**`, `Makefile`, and `docker-compose.yml`

If you discover issues in a **managed third-party** (e.g., cloud provider, upstream image), please also notify that vendor.

---

## Vulnerability Classes We Care About

- Authentication/session issues (credential leakage, JWT/session fixation, OAuth/OpenID misconfig)
- Authorization/RBAC bypass (vertical/horizontal access control, multi-tenant isolation)
- Injection (SQL, NoSQL, command, template, header injection)
- XSS, CSRF, clickjacking, CORS misconfigurations
- SSRF and request smuggling/splitting
- Deserialization and prototype pollution
- Cryptographic issues (weak key mgmt, predictable tokens, timing leaks)
- Supply chain (dependency confusion, typosquatting, signed image bypass)
- Secrets exposure (in images, env, logs, or VCS)
- Insecure defaults in Helm charts / K8s manifests (privileged pods, missing resource limits, inadequate PodSecurity, missing PDBs/HPAs)
- Misconfigured network policies / ingress

---

## Severity & Remediation SLAs

We use **CVSS v3.1** (industry-standard) to assign severity. Target timelines from triage acceptance:

| Severity | Example Impact | Target Fix Window |
| --- | --- | --- |
| **Critical** (9.0–10.0) | RCE, unauth data exfiltration, auth bypass | **72 hours** |
| **High** (7.0–8.9) | Priv-esc, tenant escape, sensitive info disclosure | **7 days** |
| **Medium** (4.0–6.9) | CSRF with limits, stored XSS behind auth, SSRF w/ egress controls | **30 days** |
| **Low** (0.1–3.9) | Best-practice deviations, verbose errors | **90 days** |

If exploitation is observed in the wild, we will issue advisories and hotfix out-of-band.

---

## Supported Versions

We support the following branches/tags for security updates:

- **`main`** — actively developed; receives all security fixes.
- **Latest release line** — e.g., `vX.Y.Z` (maintained for N-1 minor), receives backported critical/high fixes where feasible.

Older releases may receive fixes at our discretion or via upgrade guidance.

---

## Operational Hardening (What we do)

**App & API**
- Strict security headers and CSP (`packages/security/*`, `apps/web/src/middleware`)
- CSRF defenses for state-changing endpoints
- Rate limits and token buckets backed by Redis (`packages/rate-limit/*`)
- Comprehensive validation & contract types (`packages/contracts/*`)

**Data & Secrets**
- PostgreSQL with TLS, least-privileged users, WAL archiving configurable via Helm
- Redis configured with authentication and protected-mode off only within cluster network
- MinIO with unique access keys per environment; S3 policies scoped by bucket
- Secrets never committed to VCS; use sealed secrets or external secret manager. The repo contains `infra/helm/secrets/.gitkeep` to keep the dir but **no real secrets**.
- Rotation scripts in `scripts/rotate-secrets.sh`

**Kubernetes**
- Resource limits/requests, HPAs, PodDisruptionBudgets across charts
- Read-only root filesystem and non-root users where possible
- NetworkPolicies (if your cluster enforces them, add in `infra/helm/...`)
- Liveness/readiness probes; surge/rolling updates; topology spread constraints
- Prometheus ServiceMonitors + OTEL Collector for telemetry; useful for anomaly detection

**Supply Chain**
- Pin base images to digests where practical
- `pnpm-lock.yaml` + Renovate/Dependabot for dependency updates
- CI: build, test, lint, type-check, `prisma migrate diff`, and container scan
- SBOM and image scanning encouraged (e.g., Trivy/Snyk); wire into CI

---

## How We Validate Fixes

1. Add unit/integration tests reproducing the issue.
2. Add regression tests and negative tests (authz boundaries, input fuzz).
3. Update Helm/infra defaults if misconfig is involved.
4. Document operator actions in `CHANGELOG.md` and, if user-visible, release notes.

---

## Reporting Template (Optional)

Title: 
Severity (CVSS v3.1): <vector if known, e.g., AV:N/AC:L/…>
Affected Components: <paths, services>
Summary: 
Steps to Reproduce:
	1.	…
	2.	…
Impact: 
Mitigations: 
Your Environment: <OS/Browser/Cluster>

---

## Credits & Hall of Fame

We are happy to credit researchers who help secure this project. Please let us know how you’d like to be recognized. (Opt-out available.)


Thanks for helping keep our community safe.