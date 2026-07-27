# Plan 008: Bound project participants and Discord request concurrency

> **Executor instructions**: Implement only this plan. Choose a documented limit consistent with Discord channel overwrite capacity and existing board overwrites.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 007
- **Category**: perf
- **Planned at**: commit `3552f7a`, 2026-07-19
- **Execution**: DONE — approved after revision in `4d6dd29` and `d2a753d`; 994-participant cap derives from Discord's documented 1,000-overwrite ceiling, fetch concurrency is five, inserts are set-based, and concurrent additions are PostgreSQL-tested at the cap.

## Why this matters

Project creation accepts unbounded comma-separated user IDs, launches an unbounded `Promise.all` of Discord fetches, and inserts people sequentially. Large input can trigger rate limits or exceed overwrite capacity before returning a useful validation error.

## Current state

- `src/services/projects/validation.mjs:28-50` has no participant ceiling.
- `src/services/projects/index.mjs:121-125` fetches every ID concurrently.
- `src/services/projects/index.mjs:433-440` inserts participants one at a time.

## Scope

**In scope**: project constants/validation/service code, command descriptions/docs, focused tests, and repository batching helpers.

**Out of scope**: project roles, public channels, pagination, dependency-heavy concurrency libraries, and changing eligibility rules.

## Steps

1. Derive and document a safe combined participant limit after reserving overwrites for `@everyone`, bot, Global President, and scoped board roles.
2. Reject oversized or overwrite-incompatible inputs before Discord or DB work.
3. Replace unbounded fetch concurrency with a small internal bounded-concurrency helper.
4. Use a set-based/batched participant insert while preserving roles and transaction behavior.
5. Test limit−1, limit, limit+1, duplicate input, fetch failure, and bounded concurrency.

## Verification

- Focused project validation/service tests → pass.
- `npm run check && npm test` → exit 0.
- Tests assert observed concurrency never exceeds the chosen bound.
- `git diff --check` → exit 0.

## STOP conditions

- Discord's current overwrite limit cannot be established from official docs or library constants.
- The limit would break a documented existing deployment requirement.
- Batching would bypass Plan 006 eligibility guarantees.

## Maintenance notes

The ceiling must be revisited if project roles replace direct overwrites or Discord changes channel overwrite limits.
