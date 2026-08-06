# BAINSA Discord Bot

This repository provisions and runs the BAINSA Discord server described by the approved v1 permissions plan. It manages onboarding, university and division access, board appointments, and private university projects.

Cross-university projects are intentionally outside v1. Every project belongs to exactly one university and one division.

## Technology

- TypeScript 6 compiled as native Node.js ESM.
- Node.js 22 and npm 10.
- discord.js 14.27 for Gateway, REST, commands, and interactions.
- PostgreSQL through pg 8.22, with explicit migrations and transactions.
- ESLint 10 with TypeScript-ESLint and Node's built-in test runner.

Application source, operational scripts, and tests are TypeScript. Production runs only the
compiled JavaScript in `dist/`; source maps preserve TypeScript stack traces.

## Requirements

- Node.js 22 (the supported runtime line; see `.nvmrc`).
- npm 10.9.2 (pinned in `package.json`).
- A Discord application installed with the `bot` and `applications.commands` scopes.
- The privileged **Server Members Intent** enabled in the Discord Developer Portal.
- The explicit bot permissions defined by `BOT_ROLE_PERMISSIONS`; do not grant `Administrator`.
- `DISCORD_CLIENT_SECRET` in `.env` to synchronize role-specific slash-command visibility.
- The bot's highest role above every role it assigns or removes.
- PostgreSQL or Supabase Postgres.
- The credentials listed in `.env.example`.

The real `.env` is ignored by Git and must never be committed.

## Database TLS

Database connections to remote hosts use TLS with certificate verification enabled. Localhost,
`127.0.0.1`, and `::1` connections do not use TLS for local development. For a remote database
that uses a private certificate authority, set `DATABASE_SSL_CA` to that CA certificate through
your secret manager or local `.env`; do not commit the certificate contents. If your secret
manager cannot store multiline values, base64-encode the PEM certificate and set
`DATABASE_SSL_CA_B64` instead. There is no
production setting to disable certificate verification; TLS options in `DATABASE_URL` do not
override this policy.

## Fresh deployment

```bash
npm ci
npm run build
npm run db:migrate
npm run commands:register
npm run provision:dry-run
npm run provision
npm start
```

Run `npm run provision:dry-run` before every live provisioning pass. Provisioning is idempotent and does not delete Discord resources.

## Clean redeployment

When replacing an existing BAINSA installation, reset Discord and Postgres before applying migrations or provisioning:

```bash
npm ci
npm run build
npm run discord:reset -- --confirm-reset
npm run db:reset -- --confirm-reset
npm run db:migrate
npm run provision:dry-run
npm run provision
```

The Discord reset preserves the guild, its members, `@everyone`, and Discord-managed integration roles. It removes editable roles, channels, scheduled events, and guild commands. The database reset drops only the known BAINSA application tables and helper functions. Both commands refuse to run without the confirmation flag.

After clean provisioning, initial access can be restored to an existing guild member with explicit roles. Run provisioning once more afterward so the member and board assignments are reconciled into Postgres:

```bash
npm run discord:bootstrap -- \
  --user-id DISCORD_USER_ID \
  --role Researcher \
  --role Bocconi \
  --role "Bocconi - Analysis" \
  --role "Bocconi - Vice President" \
  --role "Global President"
npm run provision
npm run commands:register
npm start
```

## Server model

The initial plan contains:

- Bocconi: Projects, Analysis, Culture.
- Sapienza: Projects.
- Polimi: Projects.

Edit `INITIAL_SERVER_PLAN` in `src/constants.ts` before provisioning a new university. Once a university exists, its President or a Global President can create further divisions with `/division-create`.

Member identity uses exactly one of `Researcher` or `Alumni`. University roles grant university-level visibility. Combined roles such as `Bocconi - Analysis` grant division access. Board roles carry scoped authority, while the bot performs structural changes and records them in Postgres.

Role colors are fixed by scope: Bocconi red, Sapienza yellow, Polimi blue, Global President orange, Researcher grey, and Alumni green. Division roles use selectable square-icon colors: 🟥 🟧 🟨 🟩 🟦 🟪 🟫 ⬛. Projects default to blue 🟦, Analysis to orange 🟧, and Culture to pink 🟪. New divisions choose one of the eight colors when created.

Private project channels use direct user overwrites for members and supervisors. No project roles are created.

## Commands

Membership:

- `/member-add`
- `/member-update`
- `/member-remove`
- `/member-info`

Divisions and board:

- `/division-create`
- `/division-update`
- `/division-add-member`
- `/division-remove-member`
- `/board-assign`
- `/board-remove`
- `/board-info`

Projects:

- `/project-create`
- `/project-add-member`
- `/project-remove-member`
- `/project-update`
- `/project-close`
- `/project-info`

Announcements and scheduled events use Discord's native UI and scoped channel permissions. There are no announcement, event, showcase-management, destructive-delete, or broad maintenance commands in v1.

Commands cannot target the Bot account, including user-list fields in project creation. Governance commands acknowledge immediately before performing Discord and database work, so longer operations do not expire the interaction response window.

Slash commands are usable only in the global `LOGS / bot-log` channel or the matching university `bot-log` channel. University board roles can use their university bot log; Global Presidents can use the global bot log. The dispatcher enforces this even if a Discord permission is later changed manually. Command registration requires `DISCORD_CLIENT_SECRET` in production and synchronizes Discord's board-only command visibility: Presidents see president commands, VPs executive commands, and Heads board/project commands. Discord documents that this permission endpoint requires a Bearer token with the `applications.commands.permissions.update` scope: [Application Commands](https://discord.com/developers/interactions/application-commands#edit-application-command-permissions). The dispatcher independently applies the same channel, tier, and university scope policy before autocomplete performs any database or guild-member lookup; stale or unauthorized interactions receive no suggestions. Execution-time authorization still runs when a command is submitted.

`/guide` renders one private, role-aware message and updates it in place as the caller navigates topics and command details. Read-only lookups, guide interactions, validation errors, and private-note-only updates stay ephemeral. Successful commands that change shared state post one structured board-visible activity entry to `bot-log`; private notes and reasons remain only in the durable audit record. Provisioning keeps the `bot-log` guidance message updated and pinned.

For local development or tests only, you can intentionally skip the registration sync when no client secret is available:

```bash
npm run commands:register -- --allow-unsynced-visibility
```

Do not use this override in a production deployment: members could otherwise see commands above their board tier in Discord's client.

## Onboarding

New members can only see the read-only `START HERE` area. The onboarding flow collects a full name, member type, university, and exactly one division for Researchers. Alumni choose no division. A Division Head, Vice President, or President from that university—or a Global President—must approve the request before roles are assigned. Board roles cannot be requested through onboarding.

## Development

```bash
npm ci
npm run build
npm run dev
```

`npm run dev` performs an initial verified build, watches TypeScript for changes, and restarts the
compiled bot when output changes. Do not edit `dist/`; it is generated and ignored by Git.

## Operations

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check
npm run lint
npm run format:check
npm audit --omit=dev --audit-level=high
npm run test:connections
```

Use `npm ci` for all reproducible installs, including CI. `npm install` is reserved for intentionally updating dependencies and the lockfile.
`npm run typecheck` validates production source and operational scripts. `npm test` compiles the
complete project, uses inert local values, and does not require or read `.env`.

### Disposable PostgreSQL integration tests

`npm run test:integration` executes migrations and stateful workflow tests against a local,
disposable PostgreSQL database. It requires `TEST_DATABASE_URL`; it never reads `DATABASE_URL`
and refuses URLs that are not local or whose database name does not contain a standalone `test`
segment. The suite drops and recreates the `public` schema in that test database, so use a
dedicated database such as `bainsa_discord_test`:

```bash
createdb bainsa_discord_test
TEST_DATABASE_URL=postgres://localhost/bainsa_discord_test npm run test:integration
```

The CI workflow supplies the same disposable database through a PostgreSQL service container.
### Project Discord reconciliation

Every project create, participant change, metadata update, and close transaction also advances a
per-project desired-state generation in `project_reconciliation`. The command immediately applies
the latest desired channel name, parent, and direct permission overwrites. If Discord fails after
the database commit, the command reports that the committed project ID is pending reconciliation;
it never claims a rollback.

The bot retries up to ten pending or failed projects on startup and once per minute. A row lock held
for the full reconciliation serializes workers and project mutations, so an older attempt cannot
mark a newer generation complete. Replays use idempotent channel identity/name/parent/overwrite
operations only. Intro, showcase, and other history messages are deliberately best-effort and are
not retried, preventing duplicate announcements. Retain `project_reconciliation` rows alongside
the project record for operational observability; `status`, `attempts`, `last_error`, and timestamps
identify items needing investigation.

The bot logs structural actions in `audit_log` and sends operational messages to the configured log channels. Seeded channel messages contain no internal marker comments; their Discord message IDs are tracked in `provisioned_messages` for safe future updates. Project close operations preserve history; v1 has no project delete or separate archive command.

`admin-log` is the private operational audit channel for future bot and server-maintenance events; it is read-only to Global Presidents and the bot. `onboarding-review` is university-scoped: it displays pending onboarding requests to every board member in that university—Division Heads, the Vice President, and the President—plus Global Presidents, who approve or reject requests through the onboarding controls.
