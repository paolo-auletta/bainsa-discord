# Engineering Invariants and Completed Remediation

## Purpose

This document preserves the durable outcomes of the engineering remediation program that was
previously described by plans 001–011. Those plans were completed and reviewed in dependency
order. Their executor instructions and intermediate implementation details have been removed;
the behavior that future changes must preserve is summarized here.

The audited baseline was commit `3552f7a`. The final plan recorded 167 unit tests and 23
disposable-PostgreSQL integration tests after the architecture extraction. Later product work has
added more coverage, so current commands—not these historical counts—are the source of truth.

## Completed work

| Area | Outcome | Durable requirement |
|---|---|---|
| PostgreSQL TLS | Runtime and migrations share one connection-options policy. Remote connections verify certificates; loopback development connections do not require TLS. Private CAs are supported through `DATABASE_SSL_CA` or `DATABASE_SSL_CA_B64`. | Never add a production switch that disables certificate verification, and never commit CA contents or credentials. |
| Quality gates | Node/npm expectations, TypeScript checks, linting, formatting, CI, deterministic installation, and contributor guidance were added. | Use `npm ci`; keep CI credential-free; include all production source and operational scripts in type checks. |
| PostgreSQL integration tests | Migrations, legacy upgrades, constraints, transactions, concurrency, and failure paths can run against a disposable local/CI PostgreSQL database. | Tests must read only `TEST_DATABASE_URL`, reject unsafe database names/hosts, and retain both static migration-contract tests and execution tests. |
| Membership/project eligibility | A membership update is rejected before side effects when it would invalidate an active or paused project assignment. Project participant eligibility is revalidated at the transactional write boundary. | Do not silently remove project assignments. All writers of `project_people` must use the guarded boundary and compatible lock order. |
| Onboarding transitions | Draft edit, cancel, and submit transitions are guarded atomically, including both outcomes of submit/edit and submit/cancel races. | Do not reintroduce read-check-write status changes. Preserve ownership non-disclosure in error responses. |
| Project reconciliation | Database mutations and a generation-numbered reconciliation intent commit together. Discord channel state, the pinned canonical project home, the showcase starter, and lifecycle tags are applied idempotently and retried when necessary. | Never report a post-commit Discord failure as a database rollback. Suppress stale work, serialize competing workers, and do not replay assignment DMs or chronological transition messages. |
| Project capacity | Combined project participation is capped at 994 to reserve six of Discord's 1,000 channel-overwrite entries. Member fetch concurrency is bounded and inserts are set-based. | Validate the cap before Discord or database effects. Revisit it if Discord limits or the permission model change. |
| Provisioning reconciliation | Member recognition remains deterministic; PostgreSQL changes are batched transactionally and Discord work uses bounded concurrency of three with per-member diagnostics. | Preserve dry-run behavior, deterministic output, complete rollback for database batches, and visible retryable failures. |
| Command discovery/autocomplete | Production command registration requires visibility credentials. Autocomplete checks bot-log or project-channel scope before any database or guild-member lookup. Project-channel selection is bound to the owning project. | Discord command visibility is defense in depth. Execution-time and transactional authorization remain authoritative; unauthorized autocomplete returns no suggestions. |
| Service boundaries | Governance and project code was split into policy/formatting, repository, Discord gateway, autocomplete/read-model, and explicit orchestration modules without changing public command contracts. | Repositories stay free of Discord objects; gateways stay free of SQL; workflows keep transaction, compensation, reconciliation, and audit ordering explicit. |

## Cross-domain correctness rules

### Database and Discord effects

PostgreSQL is the durable source of truth for governed state. A workflow that commits database
state before applying Discord changes must expose the difference between these outcomes:

- rejected before commit;
- committed and fully reconciled with Discord;
- committed but pending or failed Discord reconciliation.

Project reconciliation rows are operational state. Preserve them with their projects so
`status`, `attempts`, `last_error`, generations, and timestamps remain available for diagnosis.
Only idempotent desired-state operations belong in replay. Canonical project and showcase messages
are stored and edited by identity, so they belong in reconciliation. Assignment DMs and
chronological transition messages remain best-effort and must not be duplicated by a retry.

### Authorization and scope

Client-side command visibility and guide filtering improve usability but never grant authority.
Every submitted command must still enforce server-side role, university, division, channel, and
resource rules. Autocomplete must authorize before lookup so even suggestion text cannot leak
member, university, division, or project information.

Project-channel management additionally requires either the current project `supervisor` relation
or scoped board authority. That relation is re-read after locking the project row. A supplied project
ID must match the bot-managed project identity in the current channel topic. Governance activity
from project-channel mutations is still written to the owning university `bot-log`.

Eligibility checks and governance updates use coordinated transactional locking. Future project
roles or membership attributes must be added to both sides of this invariant. Multi-member writes
must lock in a stable order to avoid deadlocks.

### Bounded external work

Discord requests must not use unbounded `Promise.all` over user-controlled or guild-sized input.
Project member lookups and provisioning reconciliation use explicit concurrency limits, stable
ordering, and per-item failure reporting. Database writes should be set-based where that does not
bypass authorization, eligibility, or audit rules.

### Migrations and test isolation

Database migrations are append-only. Never edit an applied migration to change production
behavior; create the next numbered migration and add both static contract assertions and live
PostgreSQL coverage.

The disposable integration suite may reset its dedicated test schema, so it must never default to
`DATABASE_URL` or touch an operator's existing database. See the repository README for the URL
safety rules and local command.

## Verification contract

Run the gates appropriate to a change, and run the full set before merging architecture,
transaction, migration, authorization, or deployment changes:

```bash
npm ci
npm run check
npm run lint
npm run format:check
npm test
TEST_DATABASE_URL=postgres://localhost/bainsa_discord_test npm run test:integration
npm audit --omit=dev --audit-level=high
git diff --check
```

The integration command is intentionally opt-in and requires a dedicated disposable PostgreSQL
database. No quality gate should require real Discord credentials or production database access.

## Deliberate non-goals

- Do not introduce a generic workflow or queue framework for the current reconciliation needs.
- Do not add a search index for project autocomplete without representative query-plan evidence.
- Do not trade bounded Discord concurrency for maximum throughput.
- Do not merge governance and project services into a shared base class.
- Do not weaken TLS, authorization, or test isolation for local convenience.
