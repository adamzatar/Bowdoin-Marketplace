# @bowdoin/db

Database layer for Bowdoin Marketplace.  
Implements the PostgreSQL schema, migrations, triggers, seeding, and maintenance scripts.  
Uses **Prisma ORM** with type-safe client and custom SQL for full-text search and audit logging.

---

## 📂 Structure

packages/db/
├── prisma/
│   ├── schema.prisma                 # Main Prisma schema
│   ├── sql/fts_triggers.sql          # SQL triggers to maintain tsvector search
│   └── migrations/                   # Versioned migrations (applied via migrate.ts)
│       ├── 20250904_init/
│       ├── 20250904_fts_trgm/
│       ├── 20250904_audit_logs/
│       └── 2025-09-04_add_affiliation_and_audience/
├── seed/
│   └── community.seed.ts             # Example seed for community users/listings
├── scripts/
│   └── backfill-affiliation.mts      # Utility to backfill user affiliation
├── src/
│   ├── index.ts                      # Prisma client export
│   ├── migrate.ts                    # Migration runner
│   └── seed.ts                       # Seeder entrypoint
└── README.md

---

## ⚙️ Setup

### Install dependencies
```bash
pnpm install

Ensure database is running

Local dev typically uses Docker:

docker compose up -d db

Environment

Set DATABASE_URL in your .env.local or .env.development:

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marketplace


⸻

🚀 Usage

Generate client

pnpm --filter @bowdoin/db exec ts-node src/migrate.ts generate

Apply migrations (safe for prod)

pnpm --filter @bowdoin/db exec ts-node src/migrate.ts deploy

Check migration status

pnpm --filter @bowdoin/db exec ts-node src/migrate.ts status

Reset database (⚠️ dev only)

pnpm --filter @bowdoin/db exec ts-node src/migrate.ts reset

Push schema directly (⚠️ dev only)

pnpm --filter @bowdoin/db exec ts-node src/migrate.ts push

Seed database

pnpm --filter @bowdoin/db exec ts-node src/seed.ts


⸻

📝 Conventions
	•	Migrations
Always create migrations via prisma migrate dev (never db push in prod).
Timestamp-based directories (YYYYMMDD_name) for clarity.
	•	Search
Postgres tsvector with pg_trgm + unaccent.
fts_triggers.sql keeps the index fresh automatically.
	•	Audit logs
Every sensitive change (auth, affiliation, roles, etc.) must insert a row in AuditLog.
	•	Affiliation backfill
Run backfill-affiliation.mts to classify users as bowdoin_member vs community.

⸻

🔒 Safety
	•	Prod rules
	•	reset and push are blocked unless FORCE=1.
	•	Always run deploy for production migrations.
	•	Backups
	•	Scheduled in infra repo (Helm/Postgres chart).
	•	Manual backup/restore scripts available at scripts/.

⸻

🧪 Testing

Use an ephemeral test DB (e.g., marketplace_test) and override DATABASE_URL_TEST.

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marketplace_test \
  pnpm --filter @bowdoin/db exec vitest run


⸻

📖 References
	•	Prisma Docs
	•	Postgres Full-Text Search
	•	pg_trgm Extension
	•	OWASP: SQL Injection Prevention

