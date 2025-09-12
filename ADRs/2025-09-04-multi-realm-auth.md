# ADR: Multi-Realm Authentication and Authorization

- **ID**: 2025-09-04-multi-realm-auth  
- **Status**: Accepted  
- **Date**: 2025-09-04  
- **Owner**: Identity & Platform  
- **Tags**: auth, tenancy, rbac, security, compliance

## 1. Context

We operate a single codebase that serves multiple constituencies (e.g., *community*, *university*, *enterprise*). Each constituency requires:

- Distinct identity providers (IdPs) and email login policies
- Separate RBAC boundaries and moderation tools
- Clear audit and observability per group
- Per-realm rate limits and abuse controls
- Minimal operational overhead (shared infra), strong data isolation guarantees

We already have:
- `packages/auth` with NextAuth (email + Okta) and RBAC/affiliation
- DB migrations that introduced **affiliation** and **audience** (a notion of grouping)
- API and middleware primitives (`withAuth`, rate limiting, audit)

We need a first-class **Realm** abstraction that cleanly scopes auth, RBAC, data access, and operations.

## 2. Decision

Introduce **multi-realm** support with the following principles:

1. **Realm as first-class tenant:**  
   Logical tenant key `realm` (string, stable slug). Realms are *soft multi-tenant* in the app tier with an optional fast-follow to DB-enforced RLS.

2. **Realm discovery:**  
   - Primary: **subdomain** (`{realm}.example.com`)  
   - Secondary: **header** `X-Realm` (for internal services/tests)  
   - Fallback: **default realm** = `public`

3. **Identity providers per realm:**  
   - Configure NextAuth providers per realm (Okta/email toggles, issuer/client, email templates) via `REALMS__<slug>__*` env or Helm values → ConfigMap.
   - Session cookie names are realm-qualified to avoid cross-realm session bleed.

4. **Authorization boundary:**  
   - RBAC is **realm-scoped** (roles/permissions attached to `(user_id, realm)`).
   - `affiliation` remains the per-user/realm state (e.g., verified university email).

5. **Data partitioning:**  
   - All realm-owned tables include a `realm` column (text) referencing the logical key.
   - Prisma middleware automatically injects `where: { realm: session.realm }` for read/write.
   - Background workers receive `realm` in job payloads.

6. **Rate limit & abuse:**  
   - Redis keys are prefixed with `rl:{realm}:{route}:{ip|user}`.
   - Community defaults remain, with realm-level overrides possible.

7. **Observability & audit:**  
   - All logs/metrics/traces include `realm` label.
   - Audit events include `realm` for forensic queries.

8. **Backwards compatibility:**  
   - If no `realm` is resolved, we attach `public`. Existing clients continue to work.
   - Data created pre-feature is backfilled to `public`.

## 3. Drivers & Non-Goals

### Drivers
- Regulatory separation (e.g., FERPA-like policies for university)
- Different IdPs and email policies
- Targeted moderation and rate limits
- Minimal “N deployments”; prefer shared fleet

### Non-Goals
- Full physical isolation per customer (future enterprise SKU)
- Billing/quotas (tracked separately)

## 4. Alternatives Considered

1. **Separate clusters per realm**  
   + Strong isolation; – High cost and operational toil.  
   **Rejected** for MVP; revisit for large enterprise.

2. **Path-based routing (`/r/{realm}`)**  
   + Simple; – Fragile, worse UX, messy cookies.  
   **Rejected**.

3. **DB-level RLS only**  
   + Strong guarantees; – Requires broader schema surgery now.  
   **Deferred**: ship app-level guardrails now; add RLS as fast-follow.

## 5. Architecture

```mermaid
flowchart LR
    Client -->|subdomain or X-Realm| Edge(Ingress/Nginx)
    Edge --> Web[Next.js API]
    Web --> Ctx[Context Resolver]
    Ctx -->|realm| NextAuth
    Ctx --> RBAC
    Ctx --> RateLimit
    Ctx --> Prisma[Prisma Client]
    Prisma --> Postgres[(Postgres)]
    Web --> Queue[Jobs]
    Queue --> Worker
    Web --> Obs[OTel Collector]
    Worker --> Obs