# Plan 007: Durably reconcile project database and Discord state

> **Executor instructions**: Implement only this plan. Design for idempotent retries and observable failures; do not report a failed command as wholly rolled back after a DB commit.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 003 and 006
- **Category**: bug, architecture
- **Planned at**: commit `3552f7a`, 2026-07-19
- **Execution**: DONE — approved after revision in `6d65247`, `d5a9642`, and `bd1189a`; durable generation-guarded reconciliation, deterministic channel recovery, awaited worker shutdown, and non-replayed one-shot history verified with 153 unit and 19 PostgreSQL integration tests.

## Why this matters

Project add/remove/update/close commits the database first, then mutates Discord. Failures leave durable database state divergent from channel access or lifecycle state, with no repair marker or retry mechanism.

## Current state

- `src/services/projects/index.mjs:505-635` has four DB-first workflows with Discord side effects afterward.
- Project creation has an explicit archived failure path at `src/services/projects/index.mjs:466-484`, but later mutations do not.
- `audit_log` records structural actions; use existing structured logging and audit conventions.

## Scope

**In scope**: project service/repository modules, an append-only migration for reconciliation state if needed, one explicit repair mechanism (runtime retry or operator command), audit/log messages, tests, and relevant docs.

**Out of scope**: a generic queue framework, unrelated governance workflows, destructive project deletion, and broad maintenance commands.

## Steps

1. Specify durable reconciliation state and idempotency keys for access refresh, metadata/channel refresh, and closure/archive effects.
2. Commit domain state plus pending reconciliation intent atomically.
3. Attempt Discord effects, mark success only after completion, and retain actionable failure state on error.
4. Provide a bounded, authorized retry path that safely replays the latest desired state and reports partial failures accurately.
5. Add failure-injection tests for every Discord boundary after commit, retry success, repeated retry, and newer-state supersession.

## Verification

- Disposable-Postgres failure/retry tests → all pass.
- Unit tests assert user-facing responses distinguish committed/pending reconciliation from rejected operations.
- `npm run check && npm test` → exit 0.
- `git diff --check` → exit 0.

## STOP conditions

- The approach can replay stale state over a newer project mutation.
- Idempotency requires a new external service or generic queue.
- Repair authorization would expose private project data outside existing authority.

## Maintenance notes

Reviewers should focus on replay ordering, stale-work suppression, and removal/closure access safety. Reconciliation records are operational state and need retention/observability rules.
