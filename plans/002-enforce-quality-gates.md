# Plan 002: Enforce deterministic repository quality gates

> **Executor instructions**: Implement only this plan. Run every verification command. Stop on a STOP condition and report; the reviewer maintains plan status.

## Status

- **Execution**: DONE — approved commits `446a8dd` and `f373d00` after revision; reviewer reran syntax, lint, format, and 140 tests.
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

The repository has a strong test suite but no CI, linter, formatter policy, package-manager pin, or complete source syntax check. A deterministic, documented gate is required before higher-risk transaction and architecture work.

## Current state

- `package.json:10-22` checks only `src/bot.mjs` and top-level scripts.
- `package-lock.json` is tracked; deployment docs currently use `npm install`.
- There is no `.github/workflows/`, lint configuration, `.editorconfig`, `CONTRIBUTING.md`, or repository-local agent guide.
- Existing style is two-space indentation, semicolons, single quotes, ESM `.mjs`, and Node's built-in test runner.

## Scope

**In scope**: `package.json`, `package-lock.json` only if tooling changes it, `.github/workflows/ci.yml`, `.editorconfig`, lint/format configuration, `CONTRIBUTING.md` or `AGENTS.md`, `README.md`, and focused tooling tests if needed.

**Out of scope**: broad source reformatting, behavior changes, dependency major upgrades, deployment automation, and secrets.

## Steps

1. Make the syntax check cover every tracked `.mjs` file under `src/` and `scripts/`.
2. Add a minimal lint/format check compatible with existing style; avoid mass rewrites.
3. Pin the package-manager/runtime expectations and document `npm ci` as the deterministic install path.
4. Add CI for Node 22 that runs install, check, tests, and production dependency audit.
5. Add contributor/agent instructions covering commands, append-only migrations, `.env` safety, and Discord/Postgres side-effect boundaries.

## Verification

- `npm ci` → exit 0 without changing the lockfile afterward.
- `npm run check` → exit 0 and includes all source/script modules.
- `npm test` → all tests pass.
- Any added lint/format-check command → exit 0.
- `git diff --check` → exit 0.

## STOP conditions

- Tooling requires a mass reformat of source files.
- CI needs real Discord or production database credentials.
- A new tool is incompatible with Node 22 or ESM `.mjs`.

## Maintenance notes

CI must stay credential-free and deterministic. Future scripts should be included automatically through globs/file discovery rather than a hand-maintained list.
