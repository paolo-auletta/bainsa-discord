# Plan 001: Verify PostgreSQL TLS certificates by default

> **Executor instructions**: Implement only this plan. Run every verification command. Stop on a STOP condition and report; do not update `plans/README.md` because the reviewer owns it.

## Status

- **Execution**: DONE — approved commit `14a5a7c`; reviewer reran `npm run check`, `npm test` (139 passing), `git diff --check`, and the insecure-TLS scan.
- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

Both runtime and migration pools disable certificate verification for every non-local database URL. Production governance data and credentials need authenticated TLS. Local development must remain simple, and private-CA deployments need an explicit supported configuration rather than a silent global bypass.

## Current state

- `src/db.mjs:7-12` builds the runtime `Pool` with `{ rejectUnauthorized: false }` for non-local URLs.
- `src/migrations/runner.mjs:137-144` duplicates the same policy.
- `src/config.mjs` centralizes environment parsing and returns an immutable object.
- `.env.example` documents non-secret configuration keys; never add certificate contents or credentials.

## Scope

**In scope**: `src/config.mjs`, `src/db.mjs`, `src/migrations/runner.mjs`, `.env.example`, `README.md`, and focused tests under `test/`.

**Out of scope**: credential rotation, database-schema changes, provider-specific provisioning, `.env`, and dependency upgrades.

## Steps

1. Extract one testable PostgreSQL connection-option builder shared by runtime and migrations. Localhost/loopback may disable TLS; remote URLs must use certificate verification by default.
2. Support an optional CA value through configuration without logging or persisting its contents. Do not add a general `rejectUnauthorized=false` production escape hatch.
3. Update `.env.example` and README deployment notes with verified-TLS behavior and private-CA configuration.
4. Add tests for localhost, loopback, verified remote TLS, and configured CA behavior.

## Verification

- `npm run check` → exit 0.
- `npm test` → all tests pass, including the new connection-option cases.
- `rg -n "rejectUnauthorized:\s*false" src` → matches only an explicitly local branch, never the remote configuration.
- `git diff --check` → exit 0.

## STOP conditions

- The database provider demonstrably requires insecure TLS and offers no CA chain; report the provider constraint instead of weakening the default.
- Supporting a CA would require committing certificate material.
- Existing tests require reading the real `.env` values.

## Maintenance notes

Runtime and migration pools must keep using the same builder. Review future database entrypoints for duplicate TLS configuration.
