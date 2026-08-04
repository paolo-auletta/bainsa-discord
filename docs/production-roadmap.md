# Roadmap to a Production-Ready BAINSA Deployment

## Goal

Reach a clean, production-like BAINSA deployment in which the bot is independently buildable and
publishable, server provisioning remains a separate operator workflow, all known issues are
resolved, and a new Discord server is populated with curated launch content rather than test
placeholders.

This roadmap is intentionally sequential. Resolve behavior defects before moving files, establish
the deployment boundary before the clean rehearsal, and treat the rehearsal as a release
candidate—not as another development server.

## Phase 1: Resolve the 13 tracked issues

The next implementation stage is the set of 13 issues already created for this repository.

1. Inventory each issue's expected behavior, affected domain, risk, dependencies, and acceptance
   criteria. Separate independent fixes from issues that touch the same authorization,
   transaction, Discord, or provisioning boundaries.
2. Order the work so correctness and data-integrity fixes precede user-experience cleanup and
   refactors. Avoid combining an unrelated structural move with a behavior fix.
3. Implement and verify each issue with focused regression tests. Add disposable-PostgreSQL tests
   for migrations, transactions, locking, or concurrency; add Discord-boundary tests for
   permissions, visibility, messages, or reconciliation.
4. Keep issue status and acceptance evidence current. An issue is complete only when its behavior
   is verified and the full repository gates still pass.
5. Finish with a cross-issue regression pass and review the combined result for conflicting
   assumptions, documentation drift, new secrets, or generated artifacts.

Phase 1 exit criteria:

- All 13 issues are closed with their acceptance criteria met.
- `npm ci`, checks, lint, formatting, unit tests, integration tests, audit, and `git diff --check`
  pass.
- No issue leaves an undocumented manual workaround or a known production blocker.
- Command behavior and operator documentation describe the resulting code, not the pre-fix state.

## Phase 2: Separate the deployable bot from server provisioning

The current repository contains both the long-running bot and one-off Discord server lifecycle
tools. They should remain in one development repository if that is convenient, but become distinct
products with an explicit dependency direction.

### Required boundary

The production bot must be buildable, testable, packaged, and runnable without importing or
including the server provisioner. Provisioning may consume shared naming, permission, or server
contract definitions, but the bot runtime must never depend on provisioning entrypoints, reset
tools, seed orchestration, or development-only server plans.

A likely target structure is:

```text
apps/
  bot/                 long-running runtime, commands, domain services, migrations
tools/
  server-provisioner/  create/reconcile/reset/bootstrap commands and curated seeds
packages/
  contracts/           only genuinely shared naming/permission/schema contracts
```

The exact names should follow a dependency audit rather than a mechanical directory move. If a
shared package exists, it must be small and safe to ship with the bot; do not turn it into a place
for arbitrary cross-imports.

### Separation work

1. Map imports, environment variables, scripts, database access, content seeds, and test fixtures
   used by the runtime versus provisioning.
2. Define independent entrypoints and manifests/scripts. Make bot commands obvious (`build`,
   `start`, migrations, command registration) and provisioner commands explicitly operational
   (`dry-run`, provision, reset, bootstrap).
3. Split configuration validation so production does not require provisioning-only settings and
   dangerous reset tools cannot accidentally run with a bot-only configuration.
4. Give each side focused tests and CI gates, plus one integration test that proves provisioning
   output remains compatible with bot expectations.
5. Create a bot-only production artifact and Docker build context. Verify its contents do not
   include reset scripts, provisioner entrypoints, test fixtures, local plans, or secrets.
6. Update local-development and operator documentation with the new commands and ownership
   boundary.

Phase 2 exit criteria:

- A clean checkout can build and run the bot artifact without the provisioner source tree.
- The provisioner can still create and reconcile a server that the released bot understands.
- Production packaging contains only runtime code, required migrations/contracts, production
  dependencies, and documented launch metadata.
- Bot and provisioning configuration, CI, and operational commands are clearly distinct.

## Phase 3: Rehearse a clean, production-like deployment

Create a new Discord server, a new Discord application/bot, and a fresh PostgreSQL database. Keep
them isolated from earlier development resources. Use production-style secret storage, TLS,
permissions, logging, and startup behavior even if this environment is the final rehearsal rather
than the public launch.

### Prepare the release candidate

- Freeze the Phase 1 and Phase 2 result into a versioned bot artifact.
- Record the Node/npm versions, dependency lockfile, migration set, environment-variable inventory,
  Discord intents, OAuth scopes, and minimum bot permissions.
- Enable Server Members Intent, install only the required bot/application-command scopes, avoid
  `Administrator`, and position the bot role above every role it manages.
- Prepare backup, rollback, credential-rotation, and operator-access procedures before mutating the
  new environment.

### Curate server content

Review every provisioned category, channel, forum, role, permission overwrite, and seeded message
as launch content. At minimum, finalize:

- welcome and `START HERE` material;
- rules, onboarding expectations, and member guidance;
- announcements channel purpose and posting permissions;
- forum names, descriptions, tags, posting templates, and example or starter posts;
- university and division information;
- project/showcase/history guidance;
- the pinned `/guide` message in each university `#bot-log`;
- onboarding-review and admin-log explanations for their intended operators;
- naming, branding, icons, colors, dates, links, and contact/escalation details.

Seed content should be idempotently tracked so rerunning provisioning updates owned messages rather
than duplicating them. Remove placeholder copy and test identities. Manually authored content must
have a documented ownership rule so provisioning cannot overwrite it unexpectedly.

### Execute the clean deployment

1. Provision the fresh database and configure verified TLS.
2. Build the release artifact and apply migrations.
3. Register commands with production visibility synchronization enabled.
4. Run the server provisioner in dry-run mode and review every planned role, channel, permission,
   and seeded-content change.
5. Apply provisioning, bootstrap only the minimum initial board access, rerun reconciliation, and
   verify that PostgreSQL matches the Discord state.
6. Start the bot under the intended production process/container with restart and graceful-shutdown
   behavior enabled.

### Production acceptance rehearsal

Test with accounts representing an ordinary prospective member, Researcher, Alumni, Division Head,
Vice President, university President, and Global President. Verify:

- pre-onboarding users see only the intended starting surface;
- onboarding submit, edit/cancel races, review, approval, rejection, and assigned roles;
- command discovery, autocomplete, execution authorization, and channel/university boundaries;
- role-aware `/guide` content and stale-guide access revocation;
- member, division, board, and complete project lifecycle workflows;
- exactly one privacy-safe board activity entry for every eligible successful mutation;
- database/Discord reconciliation after injected Discord failure and after process restart;
- announcements, forums, pinned messages, archives, and showcase/history presentation;
- logs and alerts contain actionable diagnostics without credentials or private notes;
- backup restoration, rollback, restart, command re-registration, and idempotent reprovisioning.

Phase 3 exit criteria:

- The new environment passes the acceptance rehearsal with no production-blocking defects.
- Content and permissions receive product-owner sign-off on desktop and mobile Discord clients.
- The bot-only artifact is the exact artifact approved for deployment.
- Secrets, owner accounts, backups, monitoring, rollback, and incident responsibilities are
  documented and assigned.
- Remaining non-blocking observations are recorded as post-launch issues with owners and priority.

## Definition of production-ready

Production-ready means more than a successful provision command. The 13 known issues are resolved;
the released bot is structurally independent of server setup tooling; the new server can be
recreated through a reviewed, idempotent operator process; launch content is complete; and the full
member and board journey has been rehearsed against the same artifact, permissions, and operating
model intended for production.
