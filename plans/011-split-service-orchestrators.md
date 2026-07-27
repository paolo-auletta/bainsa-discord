# Plan 011: Split governance and project services along stable boundaries

> **Executor instructions**: Implement only this plan. This is a behavior-preserving extraction after Plans 004–010; do not introduce a generic workflow framework.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 004–010
- **Category**: tech-debt
- **Planned at**: commit `3552f7a`, 2026-07-19
- **Execution**: DONE — approved in `24cd258`; governance and project entrypoints retain explicit workflows while pure policy/formatting, repositories, Discord gateways, and autocomplete read models moved to domain modules. Exact export contracts and static module boundaries are tested; no migration, command schema, or user-facing message changed.

## Why this matters

The governance and project services combine SQL, Discord mutations, authorization, caching, compensation, workflows, and formatting in two oversized modules. Stable boundaries will reduce regression risk and make authorization-sensitive behavior easier to test.

## Current state

- `src/services/governance/service.mjs` is about 1,500 lines and contains repository queries, Discord gateways, workflows, cache logic, and formatters.
- `src/services/projects/index.mjs` is about 870 lines with the same concerns.
- `src/onboarding/repository.mjs` plus `src/onboarding/service.mjs` is the local exemplar: repository functions are separated while service orchestration stays explicit.

## Scope

**In scope**: new focused modules under `src/services/governance/` and `src/services/projects/`, the two existing service entrypoints, imports, and tests needed to preserve public APIs.

**Out of scope**: command contract changes, database migrations, new features, renaming domain vocabulary, generic base classes/workflow engines, and unrelated provisioning modules.

## Steps

1. Capture/export the current public API and add tests that fail if command imports or behavior contracts change.
2. Extract pure formatters/policy helpers first, then repository/query functions, then Discord gateway functions, then autocomplete read models.
3. Keep command-level workflows explicit and thin in service entrypoints; preserve mutation ordering, compensation, audit payloads, and dependency injection.
4. Remove dead duplicate code only when tests prove the new module owns the behavior.
5. Add module-boundary tests and update contributor architecture notes.

## Verification

- `npm run check && npm test` → exit 0 after every extraction group.
- Import-contract tests prove all command imports still resolve.
- `git diff --check` → exit 0.
- No migration, command schema, or user-facing message diff unless explicitly required by an earlier plan and already covered.

## STOP conditions

- An extraction changes transaction/Discord effect ordering.
- A public command/service export cannot be preserved without behavior change.
- The executor is tempted to create a generic orchestration framework or combine governance and projects.
- Existing tests are insufficient to characterize a function before moving it.

## Maintenance notes

Keep repository modules free of Discord objects and Discord gateways free of SQL. Domain workflows may coordinate both, but should expose explicit compensation/reconciliation behavior.
