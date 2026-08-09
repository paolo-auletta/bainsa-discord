# Contributing

## Local quality gate

Use Node 22 and npm 10.9.2 (the versions declared in `.nvmrc` and `package.json`). Install the exact locked dependency tree with `npm ci`, then run:

```bash
npm run check
npm run build
npm run typecheck:tests
npm run lint
npm run format:check
npm test
npm audit --omit=dev --audit-level=high
```

The CI workflow runs the same commands without credentials. `npm run check` type-checks production
source and operational scripts; `npm run build` emits the complete project to `dist/`.
`npm run typecheck:tests` is a ratcheting test-type baseline: it rejects new test diagnostics while
the existing fake and boundary typing backlog is reduced. `npm test`
supplies inert local test values, so it does not read `.env`. Keep new checks deterministic and
safe to run without Discord or PostgreSQL access.

## TypeScript conventions

- Keep ESM import specifiers ending in `.js`; TypeScript's NodeNext resolver maps them to `.ts`
  during development and preserves valid imports in compiled output.
- Import types with `import type` when they are not needed at runtime.
- Keep application code under `src/`, operational entrypoints under `scripts/`, and tests under
  `test/`. Never edit generated files in `dist/`.
- Add narrow interfaces at module and external-service boundaries. Keep Discord objects out of
  repositories and database clients out of Discord gateways.
- Run `npm run check`, `npm run lint`, and `npm test` before committing.

## Safety boundaries

- Never commit `.env`, certificates, tokens, database URLs, or other credentials. Copy `.env.example` locally and supply real values only through local secure configuration or a secret manager.
- Treat migrations in `db/migrations/` as append-only once shared or deployed. Add a new numbered migration; do not edit, rename, or reorder an existing migration.
- Commands and provisioning scripts can change Discord or PostgreSQL. Preserve dry-run behavior, explicit confirmation flags, authorization checks, and the separation between planning/validation and external side effects.
- Tests must use fixtures, fakes, or local values and must not call Discord or a production database.

## Service architecture

Governance and project commands import their domain entrypoint (`governance/service.ts` or
`projects/index.ts`). Those entrypoints own explicit workflow ordering: authorization,
transactions, Discord effects, compensation or reconciliation, audits, and returned messages.
Do not replace them with a generic workflow framework.

Within each domain:

- `policy.ts`, `validation.ts`, and `formatters.ts` contain deterministic domain decisions and presentation.
- `repository.ts` owns characterized SQL reads and writes and must not accept Discord guilds, interactions, or members.
- `gateway.ts` owns characterized Discord reads and mutations and must not contain SQL or call a database client.
- `autocomplete.ts` owns read-optimized lookup queries and cache behavior; command handlers still pass through dispatcher authorization before invoking it.

Preserve the service entrypoint exports when moving code. Add a public API contract test before
changing imports, and keep effect ordering and dependency-injection shapes unchanged.
