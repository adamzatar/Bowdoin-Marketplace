# ADR 0001: <concise, action-oriented title>

- **Status**: Proposed | Accepted | Deprecated | Superseded by ADR-####  
- **Date**: YYYY-MM-DD  
- **Owner**: @github-handle (DRI)  
- **Reviewers**: @handle1, @handle2  
- **Tags**: area/<domain>, type/<architecture|security|data|ops>, risk/<low|med|high>  

> <!--
> HOW TO USE THIS TEMPLATE
> 1) Copy this file to `docs/adr/NNNN-title.md` with the next number.
> 2) Keep it short (~1–2 pages). Link to detailed docs or PRDs.
> 3) Prefer active voice and testable statements.
> 4) Every ADR must have a rollout plan and an explicit “out of scope”.
> -->

---

## 1. Context & Problem Statement
<!-- Why are we deciding this now? What’s broken, missing, or risky?
Describe the user/business problem and constraints (SLOs, compliance, deadlines, budgets). -->

- **Goals**:  
  - G1 — …  
  - G2 — …
- **Non-Goals**:  
  - NG1 — …  
  - NG2 — …
- **Constraints / Assumptions**:  
  - C1 — … (e.g., “must work on k8s, Postgres 15, Redis 7”)  
  - A1 — …

## 2. Decision
<!-- One clear, testable decision. Include the “because…” in one or two sentences. -->

**We will** … **because** …

### 2.1 Scope of Change
- Affected components: `apps/web`, `packages/auth`, `infra/helm/*`, …  
- Public API / contracts changed: yes | no (if yes, summarize)

## 3. Rationale
<!-- Why this option over others? Summarize key evaluation criteria (cost, risk, time, ops). -->
- Benefits: …  
- Trade-offs / costs: …

## 4. Alternatives Considered
<!-- List serious alternatives with 1–3 bullets each. Include “do nothing” when relevant. -->
1. **Alternative A — …**  
   - Pros: …  
   - Cons: …  
2. **Alternative B — …**  
   - Pros: …  
   - Cons: …  
3. **Do nothing**  
   - Pros: …  
   - Cons: …

## 5. Design Overview
<!-- High-level architecture. Include a diagram or link. -->
- **Architecture**: text + link to diagram (Mermaid, Excalidraw, etc.)
- **Data model / schema**: tables/fields changed; migrations id(s)
- **Interfaces**: APIs/queues/events; contracts and versioning
- **Backwards compatibility**: how maintained or explicitly broken

```mermaid
%% optional
flowchart LR
  Client -->|...| ServiceA --> DB[(Postgres)]
  ServiceA --> Queue[(BullMQ)]

6. Security, Privacy & Compliance
	•	Threat model summary & mitigations (authn/z, SSRF, injections, secrets)
	•	Data classification / PII touched? (DPA/FERPA/GDPR, retention)
	•	Keys/secrets: source, rotation, access controls
	•	Privacy impact assessment required? yes | no

7. Reliability & Performance
	•	SLO/SLA targets and expected impact (latency, error budget)
	•	Capacity planning (QPS, storage, cache sizing)
	•	Failure modes & graceful degradation
	•	Backpressure / rate limit interactions

8. Observability
	•	Metrics: counters, histograms, SLO burn metrics
	•	Logs: structured fields (request_id, realm, user_id)
	•	Traces: span names, boundaries, sampling rules
	•	Dashboards / Alerts: links & alert policies

9. Operations & Runbooks
	•	Deployments (Helm values, feature flags, config toggles)
	•	Runbooks for common incidents (link)
	•	Backups/restore impacts
	•	Cost implications (cloud resources, licenses)

10. Rollout Plan
	•	Pre-reqs: migrations, infra changes, secrets
	•	Phases:
	1.	Dark launch / canary / shadow traffic
	2.	10% → 50% → 100% rollout
	3.	Post-rollout verification checklist
	•	Rollback Plan:
	•	How to disable / revert safely
	•	Data migration rollback or forward-fix only

11. Testing Strategy
	•	Unit / integration / e2e coverage focus
	•	Load / chaos tests
	•	Security tests (fuzzing, dependency scanning)
	•	Acceptance criteria (bullet list)

12. Open Questions
	•	Q1 — …
	•	Q2 — …

13. Consequences
	•	Positive: …
	•	Negative: …

14. References
	•	Related ADRs: ADR-#### (#link)
	•	PRDs / Issues / Tickets: …
	•	External references / prior art: …

⸻

Changelog
	•	YYYY-MM-DD — v1 — Proposed
	•	YYYY-MM-DD — v2 — Addressed review comments
	•	YYYY-MM-DD — Accepted | Deprecated | Superseded by ADR-####

Filing checklist (delete after use):
	•	[ ] Stakeholders & reviewers assigned
	•	[ ] Security & privacy reviewed (if applicable)
	•	[ ] Migrations & rollback steps documented
	•	[ ] Observability & alerts defined
	•	[ ] Rollout plan + runbook linked
	•	[ ] Cost reviewed (FinOps)