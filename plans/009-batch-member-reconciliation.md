# Plan 009: Batch provisioning member reconciliation safely

> **Executor instructions**: Implement only this plan. Preserve dry-run output and per-member failure visibility; Discord concurrency must remain bounded.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 002
- **Category**: perf
- **Planned at**: commit `3552f7a`, 2026-07-19
- **Execution**: DONE — approved after revision in `17c9ef9` and `ffce610`; deterministic ID ordering, concurrency-three Discord role application, set-based PostgreSQL writes, mixed-failure visibility, full rollback, and successful retry are verified.

## Why this matters

Provisioning fetches the guild roster, then serially applies Discord role changes and three-plus database operations for every recognized member. Reconciliation time grows with members and assignments.

## Current state

- `src/provision/members.mjs:12-57` serializes the complete member loop.
- `src/provision/members.mjs:185-240` issues fixed writes plus one write per division and board assignment.
- `test/provision-plan.test.mjs` demonstrates the repository's pure-plan testing style; preserve deterministic summaries.

## Scope

**In scope**: `src/provision/members.mjs`, focused provisioning DB/helpers, tests, and operational docs if output changes.

**Out of scope**: changing recognition policy, removing dry-run, changing role names, full provisioner refactor, or unbounded parallelism.

## Steps

1. Separate pure recognition/planning from effect execution while preserving summary order.
2. Batch/set-write recognized members, divisions, and board assignments in deliberate transaction boundaries.
3. Apply Discord role changes with a small configurable/internal concurrency bound and per-member result tracking.
4. Preserve retryable errors and do not hide partial failures.
5. Add tests for batching, deterministic output, dry-run no-writes, bounded concurrency, and mixed failures.

## Verification

- Focused provisioning tests → pass.
- `npm run check && npm test` → exit 0.
- Tests assert DB operation count is not proportional to assignment count and Discord concurrency is bounded.
- `git diff --check` → exit 0.

## STOP conditions

- Batching cannot preserve per-member auditability.
- The existing DB interface lacks transactions and changing it would overlap Plan 011 substantially.
- Rate-limit behavior requires unbounded or opaque third-party concurrency machinery.

## Maintenance notes

Batch size and Discord concurrency are operational controls. Future provisioning resources should reuse the same bounded execution pattern.
