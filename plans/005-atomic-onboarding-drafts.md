# Plan 005: Make onboarding draft transitions atomic

> **Executor instructions**: Implement only this plan. Keep the existing onboarding UI flow and user-facing vocabulary.

## Status

- **Execution**: DONE — approved commits `fedb8ae` and `9b6f68c` after adding both winner orderings for edit/cancel versus submit; full integration suite passes.
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 003
- **Category**: bug
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

Draft edit/cancel paths check status and then update in separate queries. A concurrent submit can move the request to pending between those operations, allowing the persisted request to diverge from the board review message.

## Current state

- `src/onboarding/service.mjs:374-385` performs a preflight read before `updateDraft`.
- `src/onboarding/repository.mjs:120-127` updates by ID and owner without `status = 'draft'`.
- Submission itself locks and verifies the request at `src/onboarding/service.mjs:204-214`.

## Scope

**In scope**: `src/onboarding/repository.mjs`, `src/onboarding/service.mjs`, onboarding unit tests, and PostgreSQL integration tests/helpers.

**Out of scope**: redesigned components, approval policy changes, new onboarding states, or review-channel permissions.

## Steps

1. Make draft edits and cancellation conditional on ownership and current `draft` status in the write query/transaction.
2. Distinguish “not found” from “no longer editable” sufficiently for a stable user-facing response without exposing another user's request.
3. Ensure submit-versus-edit and submit-versus-cancel interleavings have one valid winner and leave the review message consistent with persisted data.
4. Add deterministic repository/service tests and real-Postgres concurrency coverage.

## Verification

- Focused onboarding tests → all pass, including both interleavings.
- Disposable-Postgres integration command → all pass.
- `npm run check && npm test` → exit 0.
- `git diff --check` → exit 0.

## STOP conditions

- Correctness would require editing a pending review message from an unrelated request path.
- PostgreSQL concurrency cannot be tested without a production database.
- The write path cannot preserve the existing ownership non-disclosure behavior.

## Maintenance notes

Future onboarding statuses must use guarded transitions. Avoid reintroducing read-check-write sequences for mutable state.
