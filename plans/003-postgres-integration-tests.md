# Plan 003: Execute migrations and stateful workflows against disposable PostgreSQL

> **Executor instructions**: Implement only this plan. Run every verification command available locally. Stop and report if disposable PostgreSQL cannot be provisioned without production credentials.

## Status

- **Execution**: DONE — approved commits `1aee224` and `8d91584`; reviewer ran 142 unit tests and the six-test disposable-Postgres suite twice. Scope expanded minimally to fix the compensation SQL type-inference defect exposed by the new suite.
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 002
- **Category**: tests, migration
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

Current migration tests inspect SQL and runner source text; project tests substitute in-memory query objects. They cannot catch invalid DDL, real constraint behavior, transaction isolation problems, or Discord-after-commit failures.

## Current state

- `test/migration-runner.test.mjs` reads source and matches regexes.
- `test/migration-contract.test.mjs` reads SQL and matches tokens.
- `test/project-service.test.mjs:203-220` uses a fake `query`/`transaction` object.
- `src/migrations/runner.mjs:177-237` can target an explicit `databaseUrl` and closes its pool.

## Scope

**In scope**: test helpers under `test/`, new integration test files, package/CI configuration needed for a disposable PostgreSQL service, and documentation of the integration-test command.

**Out of scope**: production DB access, changes to existing migration files, Docker orchestration beyond what CI/tests need, and application behavior fixes from later plans.

## Steps

1. Add an opt-in/local-and-CI integration-test command that requires a clearly named disposable test URL and refuses non-test-looking databases.
2. Run the real migration runner against a fresh disposable database/schema and assert tables, constraints, indexes, status, idempotent rerun, and checksum drift behavior.
3. Add a representative legacy-schema upgrade fixture based on the supported v1 upgrade path.
4. Add transaction/failure-path test helpers for onboarding, governance, and project services while keeping Discord mocked at controlled boundaries.
5. Wire the disposable PostgreSQL service into CI without storing credentials.

## Verification

- `npm run check` → exit 0.
- `npm test` → unit/static tests pass.
- The new integration-test command against a disposable URL → all integration tests pass and clean up their schema/database.
- Re-running the integration command → passes again without leaked state.
- `git diff --check` → exit 0.

## STOP conditions

- Tests could connect to the production `DATABASE_URL` by default.
- Isolation requires modifying or deleting the operator's existing database.
- A representative legacy fixture cannot be derived from tracked migration contracts.

## Maintenance notes

Never weaken the fast static migration-contract tests; they complement execution tests. Every future migration should receive both a contract assertion and disposable-Postgres execution coverage.
