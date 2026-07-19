# Contributing

## Local quality gate

Use Node 22 and npm 10.9.2 (the versions declared in `.nvmrc` and `package.json`). Install the exact locked dependency tree with `npm ci`, then run:

```bash
npm run check
npm run lint
npm run format:check
npm test
npm audit --omit=dev --audit-level=high
```

The CI workflow runs the same commands without credentials. `npm test` supplies inert local test values, so it does not read `.env`. Keep new checks deterministic and safe to run without Discord or PostgreSQL access.

## Safety boundaries

- Never commit `.env`, certificates, tokens, database URLs, or other credentials. Copy `.env.example` locally and supply real values only through local secure configuration or a secret manager.
- Treat migrations in `db/migrations/` as append-only once shared or deployed. Add a new numbered migration; do not edit, rename, or reorder an existing migration.
- Commands and provisioning scripts can change Discord or PostgreSQL. Preserve dry-run behavior, explicit confirmation flags, authorization checks, and the separation between planning/validation and external side effects.
- Tests must use fixtures, fakes, or local values and must not call Discord or a production database.
