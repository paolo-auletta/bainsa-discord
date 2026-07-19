# BAINSA Discord Bot

This repository provisions and runs the BAINSA Discord server described by the approved v1 permissions plan. It manages onboarding, university and division access, board appointments, and private university projects.

Cross-university projects are intentionally outside v1. Every project belongs to exactly one university and one division.

## Requirements

- Node.js 22 or newer.
- A Discord bot with `Administrator` while provisioning and operating v1.
- `DISCORD_CLIENT_SECRET` in `.env` to synchronize role-specific slash-command visibility.
- The bot's highest role above every role it assigns or removes.
- PostgreSQL or Supabase Postgres.
- The credentials listed in `.env.example`.

The real `.env` is ignored by Git and must never be committed.

## Database TLS

Database connections to remote hosts use TLS with certificate verification enabled. Localhost,
`127.0.0.1`, and `::1` connections do not use TLS for local development. For a remote database
that uses a private certificate authority, set `DATABASE_SSL_CA` to that CA certificate through
your secret manager or local `.env`; do not commit the certificate contents. There is no
production setting to disable certificate verification; TLS options in `DATABASE_URL` do not
override this policy.

## Fresh deployment

```bash
npm install
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
npm install
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

Edit `INITIAL_SERVER_PLAN` in `src/constants.mjs` before provisioning a new university. Once a university exists, its President or a Global President can create further divisions with `/division-create`.

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
- `/division-rename`
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

Slash commands are usable only in the global `LOGS / bot-log` channel or the matching university `bot-log` channel. University board roles can use their university bot log; Global Presidents can use the global bot log. The dispatcher enforces this even if a Discord permission is later changed manually. With `DISCORD_CLIENT_SECRET` configured, command registration also makes Discord show only the commands appropriate to the member's board level: Presidents see president commands, VPs executive commands, and Heads board/project commands. Scope checks still run when a command is submitted.

## Onboarding

New members can only see the read-only `START HERE` area. The onboarding flow collects a full name, member type, university, and exactly one division for Researchers. Alumni choose no division. A university Vice President or President, or a Global President, must approve the request before roles are assigned. Board roles cannot be requested through onboarding.

## Operations

```bash
npm test
npm run check
npm run test:connections
```

The bot logs structural actions in `audit_log` and sends operational messages to the configured log channels. Seeded channel messages contain no internal marker comments; their Discord message IDs are tracked in `provisioned_messages` for safe future updates. Project close operations preserve history; v1 has no project delete or separate archive command.

`admin-log` is the private operational audit channel for future bot and server-maintenance events; it is read-only to Global Presidents and the bot. `onboarding-review` is university-scoped: it displays pending onboarding requests to that university's President, Vice President, and Global Presidents, who approve or reject requests through the onboarding controls.
