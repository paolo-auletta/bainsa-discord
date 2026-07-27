# Plan 010: Enforce board-only command discovery and autocomplete

> **Executor instructions**: Implement only this plan. Treat Discord command visibility as defense in depth; server-side authorization must remain authoritative.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 002
- **Category**: security
- **Planned at**: commit `3552f7a`, 2026-07-19
- **Execution**: DONE — approved in `0c2d5b1`; production registration requires visibility credentials, a documented local-only override remains, and autocomplete is denied before lookup unless channel, board tier, and university scope all match.

## Why this matters

Command-permission sync is optional, while autocomplete requests bypass the dispatcher checks used for submitted commands. When visibility sync is absent or stale, ordinary members may receive board-only university/division or guild-member suggestions.

## Current state

- `src/config.mjs:17` treats `DISCORD_CLIENT_SECRET` as optional.
- `src/runtime/command-permissions.mjs:58-63` silently skips synchronization without it.
- `src/runtime/dispatcher.mjs:36-40` invokes autocomplete without channel or authority checks.
- `src/commands/projects/index.mjs:94-111` searches guild members for project-create suggestions.

## Scope

**In scope**: configuration/registration behavior, dispatcher autocomplete guards, command visibility policy helpers, autocomplete handlers/tests, `.env.example`, and README.

**Out of scope**: removing execution-time authorization, changing board hierarchy, storing OAuth tokens, or changing Discord guild privacy settings.

## Steps

1. Make production command registration fail clearly when visibility credentials are missing, while retaining an explicit documented development/test mode if necessary.
2. Apply command-channel and role/scope authorization to autocomplete before any DB or guild-member lookup.
3. Return an empty autocomplete response for unauthorized/stale interactions without leaking details.
4. Keep execution authorization unchanged and add tests for normal member, wrong channel, each board tier, missing secret, and sync failure.

## Verification

- Command-permission, dispatcher, and autocomplete tests → pass.
- `npm run check && npm test` → exit 0.
- Tests prove unauthorized autocomplete performs no DB/member lookup.
- `git diff --check` → exit 0.

## STOP conditions

- Discord does not provide enough interaction context to apply the same authority model safely.
- Requiring the client secret would break a supported production deployment the README promises.
- A proposed guard depends only on client-visible command permissions.

## Maintenance notes

Every new autocomplete command must declare its visibility tier and pass through the common guard before doing lookup work.
