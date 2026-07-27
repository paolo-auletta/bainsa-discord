# Plan 006: Enforce participant eligibility at the project write boundary

> **Executor instructions**: Implement only this plan. Use real PostgreSQL tests for concurrency behavior; do not rely only on mocks.

## Status

- **Execution**: DONE — approved commits `150a853` and `d23b0b8`; reviewer verified both race winners and a real reversed multi-member lock test across 14 integration cases.
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 003 and 004
- **Category**: bug, migration
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

Project create/add validates membership before opening the write transaction. A concurrent governance change can invalidate the user before `project_people` is inserted, and the database currently constrains only IDs and role values.

## Current state

- `src/services/projects/index.mjs:411-443` validates then creates project people.
- `src/services/projects/index.mjs:498-521` repeats the pattern for add/update.
- `db/migrations/003_upgrade_v1_contract.sql:601-626` has no membership-eligibility guard.
- Migrations are append-only; create a new numbered migration rather than editing applied files.

## Scope

**In scope**: project service/repository code, governance coordination needed for locking, one new append-only migration if justified, migration contracts, and real-Postgres concurrency tests.

**Out of scope**: modifying migrations 003–006, changing eligibility rules, automatic cross-university projects, or durable Discord reconciliation.

## Steps

1. Define exact database invariants for member, supervisor, and board-liaison roles based on current product rules.
2. Revalidate inside the project write transaction under locking/isolation that prevents membership mutation from racing the insert.
3. Add an append-only database guard only if it can enforce the invariant without breaking legitimate onboarding/governance workflows; otherwise document why transactional locking is the authoritative boundary.
4. Ensure governance membership updates use compatible lock ordering to avoid deadlocks.
5. Add real-Postgres tests for add/create racing removal, university move, type change, and division change.

## Verification

- Migration static and execution tests → pass.
- Concurrency tests prove no invalid `project_people` row is committed.
- `npm run check && npm test` → exit 0.
- `git diff --check` → exit 0.

## STOP conditions

- The only proposed trigger would query mutable cross-table state unsafely or deadlock normal workflows.
- Lock ordering conflicts with onboarding/governance and cannot be resolved within scope.
- Current production data violates the invariant and needs an explicit cleanup decision.

## Maintenance notes

Keep the invariant in one named repository/service boundary. Every future writer of `project_people` must use it or be rejected by the database.
