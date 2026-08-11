# BAINSA Discord Bot Command Reference

This document describes the v1 command surface implemented by the BAINSA Discord bot.

Cross-university projects are deliberately excluded from v1. Every project belongs to one university and one division.

## How Commands Work

### Where commands can be used

Governance commands and `/project-create` can only be run in a channel named `bot-log`:

- `LOGS / bot-log` for Global Presidents.
- The `bot-log` channel inside a university category for that university's board.

Project-scoped commands can also be run in the owning private project channel:

- Every participant can run `/project-info`.
- Project supervisors and scoped board roles can run `/project-update` and `/project-close`.
- The owning project is inferred from the bot-managed channel topic. Outside a project channel,
  the private panel provides a scoped project selector and search.

Autocomplete is subject to the same command-channel, board-tier, and university scope checks before the bot queries Postgres or Discord's member directory. An interaction with missing or stale channel/member context, or an unauthorized caller, receives an empty suggestion list.

The bot checks the channel in the dispatcher before running a command. A command copied into another channel is rejected even if a Discord permission is changed manually. A mutation run in a project channel posts its project transition there but routes its governance activity entry to the owning university `bot-log`.

Successful commands that change shared BAINSA state post a concise board-visible activity entry in that `bot-log` channel. The entry records the affected item, scope, meaningful state change, and command actor. Internal notes, removal reasons, and project final notes are never included.

`/guide`, `/member-info`, `/board-info`, `/project-info`, validation errors, failures, and updates that change only private notes remain ephemeral and visible only to the command actor. They are not added to channel history. The PostgreSQL audit log remains the complete technical record.

### Who sees commands

Discord command visibility is synchronized by the bot when `DISCORD_CLIENT_SECRET` is configured. The visibility tiers are:

| Tier | Visible commands |
| --- | --- |
| Global President | All commands, with global scope where permitted |
| University President | President commands and all board/project commands |
| University Vice President | Executive member commands and all board/project commands |
| Division Head | Board/project commands; execution is restricted to their division |
| Researcher or Alumni | Project-scoped commands; execution succeeds only for projects and roles they currently hold |

Visibility is only the user interface layer. Every command performs a second server-side authorization check when submitted.

## Private Guide

### `/guide`

**Who can use it:** Global Presidents and university board members in a valid `bot-log`.

The bot reads the caller's current board roles and command-channel scope, then shows a private guide containing only the commands and university/division scopes available to that person. Members with multiple roles see the union of their effective access.

The guide is organised by workflow:

- Manage members and divisions.
- Manage projects.
- Look up information.
- Review role-specific rules and limits.

Buttons and command selectors update the same ephemeral message in place. Every component interaction rechecks current roles, so an already-open guide cannot preserve access after a role changes. Running or navigating `/guide` never creates a board-visible activity entry.

### Scope rules

- Global Presidents can operate across all universities.
- University Presidents and Vice Presidents can operate only within their university, except where a command explicitly says otherwise.
- Division Heads can operate only within their assigned division for division and project operations.
- A university President can assign or remove university board roles, including university Presidents. Vice Presidents can manage Head and Vice President roles only. Multiple active co-Presidents are supported.
- `member-remove` is limited to university Presidents, university Vice Presidents, and Global Presidents. A Vice President cannot remove their university President.
- The Bot account cannot be managed, assigned, promoted, removed, or included in a project participant list.
- Commands do not change the Bot account's status, roles, membership, or permissions.

### Autocomplete and selection

- Panel flows infer the university from a university-specific `bot-log`; the global `bot-log`
  shows a scoped university selector when one is needed.
- Remaining inline university fields search active universities.
- A division field searches only active divisions belonging to the selected university. The division list is empty until a valid university value has been selected.
- Project selectors show the latest 25 visible matches as `#id Name • University, Division • Status`; `/project-close` limits the matches to active and paused projects. Inside a project channel, autocomplete returns only that project. Discord does not render more than 25 autocomplete choices at once, so typing a narrower name, university, division, or ID searches the full candidate set.
- Project creation is a private five-step wizard with native Discord modals and selectors. The database validates the selected people against the project scope before creation.
- Date fields use strict `YYYY-MM-DD` text. Discord slash commands do not provide a native calendar/date option.
- The Bot account is rejected by both native command targets and project participant selectors.

## Member Commands

New members are admitted through the onboarding flow and a board approval. That workflow creates the active member record, applies managed roles, records the review, and sets the verified full-name nickname.

### `/member-update`

**Who can use it:** Global Presidents, university Presidents, and university Vice Presidents, subject to university scope.

The command has no inline fields. It opens a private member-first panel:

1. Select the member.
2. Review the current type, university, divisions, active-project context, and private-note state.
3. Change the member type, university where authorized, divisions through a multi-select, or private notes.
4. Review the complete before/after state and confirm.

University Presidents and Vice Presidents cannot move a member outside their scoped university;
Global Presidents receive the university selector. The bot rechecks scope and active-project
eligibility at confirmation, then updates the database and reconciles Discord roles. Changing a
Researcher to Alumni clears division assignments. Existing board assignments must remain
compatible with the selected member type.

### `/member-remove`

**Who can use it:** Global Presidents on any member; a university President or Vice President only on members in that university.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Member to remove from the server |
| `reason` | No | Audit reason and Discord kick reason |

The bot validates authority, immediately kicks the member from Discord, deactivates their application records and assignments, removes managed access, cleans direct project-channel overwrites, and writes an audit entry. The Bot and protected Global President accounts cannot be removed by university officers.

### `/member-info`

**Who can use it:** Global Presidents and university board members. Results are limited to the actor's university unless the actor is a Global President.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | No | Member to inspect; when omitted, the command uses the command actor where supported |

The bot privately shows the recorded full name, member type, university, divisions, board roles, and active project assignments.

## Division Commands

### `/division-create`

**Who can use it:** Global Presidents and university Presidents for their command-channel scope.

The command has no inline fields. It opens a private three-step flow for the division name,
semantic colour, initial Head, optional text/voice spaces, and final review. A university bot-log
supplies its university automatically; the global bot-log shows the university selector. Nothing
is created before confirmation.

The bot then creates the division record, colour-matched access and Head roles, and the requested
channels under the university category. It assigns the selected person `Researcher`, the
university role, the ordinary division role, and the new Head role. The new Head is also recorded
in the board assignments table.

### `/division-update`

**Who can use it:** Global Presidents and university Presidents for their command-channel scope.

The command has no inline fields. Its private panel selects the university when it is not inferred,
selects the active division, stages a new name and/or colour, and presents a final review. Provide
at least one real change. On confirmation, the bot validates uniqueness, updates the persisted
division colour, reconciles the access and Head roles, renames the linked text/voice channels with
the current colour icon, and records the change.

### `/division-add-member`

**Who can use it:** A university President or Vice President, and a Division Head for their own division. Global President support is deferred to issue #70.

The command has no inline fields. Run it in the university `bot-log`; the panel infers that university, asks for a member first, and loads their current record and division memberships. It then offers only divisions the actor may manage and which the active Researcher has not already joined. Memberships outside a Head's scope remain out of the action control.

The final review shows the complete division set after the change. On confirmation, the bot revalidates authority, active Researcher eligibility, university, and current memberships; assigns the managed university/division Discord roles; adds the relationship; posts activity; and sends the member a private handoff.

### `/division-remove-member`

**Who can use it:** A university President or Vice President, and a Division Head for their own division. Global President support is deferred to issue #70.

The command has no inline fields. Its member-first panel infers the university from `bot-log`, then displays every current division membership. A President or Vice President can act across that university; a Head sees other memberships as read only and can act only on their own division. Because Discord string-select options cannot be disabled individually, only safe actionable divisions appear in the selector while every read-only or blocked division remains visible in the summary with its reason.

Removal is blocked when the division is required by an active Head assignment, by active project membership, or by the rule that a non-executive Researcher must keep at least one division. The actor can add an optional private reason in the panel. The final review shows the remaining divisions. Confirmation revalidates the database state before removing only the selected relationship and managed role; university membership remains intact. Activity omits the reason, while the audit record and affected member's private handoff retain it.

## Board Commands

### `/board-add-member`

**Who can use it:** A university President or Vice President in their university `bot-log`. A President can appoint a co-President; a Vice President cannot appoint or manage a President. Global President support is deferred to issue #70.

The command has no inline fields. The private panel infers the university, asks for the member first, and loads their current board and division state. It offers only available roles: occupied or already-held appointments are omitted, President is offered only to a President, and Head opens a second division selector containing only eligible unoccupied divisions.

The final review shows the resulting board roles, division access, and any Head assignment that the appointment supersedes. Confirmation revalidates authority and current database state, reconciles managed Discord roles, records the appointment, posts activity, and sends the member a private handoff. Assigning a Head moves the member into the selected division and replaces another Head assignment in that university; assigning an executive clears university division and Head access according to the database invariant.

### `/board-remove-member`

**Who can use it:** A university President or Vice President in their university `bot-log`. A President can remove a co-President; a Vice President cannot select or manage a President. Global President support is deferred to issue #70.

The command has no inline fields. After member selection and confirmation, the panel loads and lists all current board roles, including roles outside the current university as read only. Only roles within the actor's hierarchy appear in the action selector. Multiple Head appointments are listed separately, and the selector also provides an explicit **All Head roles** action when applicable.

The actor can add an optional private reason before reviewing the exact roles and preserved base access. The actor-bound session expires after 15 minutes and revalidates authority and the selected assignment at save time. Confirmation deactivates only the requested assignment or explicit all-Heads selection and removes the managed role while preserving Researcher/Alumni and university access. Shared activity excludes the private reason; the audit record and affected member's private handoff include it. A committed change is never presented as safe to retry merely because activity or DM delivery failed.

### `/board-info`

**Who can use it:** Global Presidents and any active board member of the selected university.

| Field | Required | Meaning |
| --- | --- | --- |
| `university` | Yes | University board to inspect |

The bot privately returns the active board roster and reports missing Discord roles or members so the caller can identify synchronization problems.

## Project Commands

All v1 projects are private, university-scoped, and division-scoped. Project channels use direct Discord member overwrites; the bot does not create project roles.

### `/project-create`

**Who can use it:** Global Presidents, the selected university's President or Vice President, and the Head of the selected division.

The command has no inline arguments. It opens a private guided setup that stays in one ephemeral message:

1. Enter the project name in a modal.
2. Select the owning university and division.
3. Select the initial members and supervisors with two Discord-native multi-user selectors.
4. Enter the start and expected-end dates, add a required public summary, and optionally add private internal working notes.
5. Review the complete project and press **Create project**.

The project name remains at the top of every setup card after it is entered. Back and edit controls preserve the current draft, Cancel creates nothing, and the project is not persisted until the final confirmation. Each participant selector accepts up to 25 people and searches Discord server nicknames and usernames. Onboarding approval sets the server nickname from the recorded onboarding name, so native user search can find members by that name. Both participant selections are required.

The selected university and division remain authoritative: the database rejects a person who does not meet the appropriate project eligibility rule, rejects duplicate people across the two groups, and rejects the Bot account. A project has at most 994 unique direct participants across members, supervisors, and board liaisons; the team can be changed later through `/project-update`. This reserves six of Discord's 1,000 permission overwrites for `@everyone`, the Bot, Global President, and the scoped Head, Vice President, and President roles. Discord documents this limit as error 30060, “Maximum number of channel permission overwrites reached (1000)”: [Discord API error codes](https://discord.com/developers/topics/opcodes-and-status-codes).

When valid, the bot atomically commits the project, participant records, audit entry, and pending reconciliation intent to PostgreSQL. It then immediately runs an idempotent reconciliation that creates or repairs the private project channel, its scoped access, its two pinned messages (the canonical project record and workspace guide), the university showcase starter, and the division/lifecycle tags. If Discord work fails, the committed project is reported as pending and retries automatically. Once access is ready, assigned people receive a best-effort role-aware handoff DM with links and a recommended first step.

### `/project-update`

**Who can use it:** Project supervisors; Global Presidents; the selected project's university President or Vice President; and the selected project's division Head.

The command has no inline fields. Inside a project channel, the project is inferred. From a bot-log,
the private panel offers a scoped selector plus project search. The panel supports:

- Project name, expected end, public summary, private working notes, and active/paused status.
- Participant additions and role changes for members, supervisors, and board liaisons.
- Participant removals with an optional private reason.
- A complete review of the final project and team before saving.

The bot rechecks authority, eligibility, capacity, and stale project/team state. It commits project
metadata and the complete participant set together, then reconciles channel access, the pinned
project record and workspace guide, the showcase starter, and lifecycle tags. New or changed
participants receive a handoff; removed participants receive a private notification when possible.
Visible project and team changes share one board activity card. Notes and removal reasons remain
private. Only active or paused projects can be changed.

### `/project-close`

**Who can use it:** Project supervisors; Global Presidents; the selected project's university President or Vice President; and the selected project's division Head.

The command has no inline fields. Inside a project channel, the project is inferred; from a bot-log,
the private panel provides an active/paused project selector and search. The flow explains the
resulting access change, collects the public conclusion and private handover notes in a modal, and
requires a destructive final review.

The bot marks the project `completed`, records the public conclusion and private handover notes,
applies the `Completed` showcase tag, edits both canonical summaries, locks normal project-member
sending while preserving read history, and moves the channel into `ARCHIVE / HISTORY`. The
showcase never exposes private handover notes. Only active or paused projects can be closed. There
is no separate archive command in v1, and closing a project does not set the database status to
`archived`.

### `/project-info`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, the selected project's division Head, and project participants who can view that project.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Outside project channel | Project selected through autocomplete; inferred inside its project channel |

The bot privately shows the maintained project record: scope, status, timeline, workspace, showcase, project brief, team, public conclusion when complete, and internal handover notes when present.

### University showcase replies

The bot owns post creation and the canonical starter. University members may reply inside existing
project posts, attach shareable files, embed links, react, ask a relevant question, or express a
concrete contribution idea. They cannot create new showcase posts. Discord applies this reply
permission to the whole forum rather than one project thread at a time; server-side guidance and
moderation therefore preserve the project-specific content boundary. Private drafts, decisions,
internal notes, and handover details stay in the project channel.

## Channel-Only Operations

Announcements and events are not bot commands in v1. Board members publish announcements from the appropriate announcement channel and create calendar events through Discord's calendar/event UI. University board members are scoped to their university; a university President can create global announcements and events where the channel permissions allow it.

The bot also does not expose showcase/forum management commands or broad admin/maintenance commands in v1.

## Common Failure Handling

- Long-running commands defer an ephemeral acknowledgement immediately.
- Successful shared-state changes post one formatted board-visible activity entry after the operation is accepted.
- Guides, lookups, failures, validation messages, and private-note-only updates remain ephemeral.
- Autocomplete handlers send at most one response and safely ignore expired or already-acknowledged interactions.
- User-facing validation errors mention Discord members rather than exposing raw IDs.
- Database writes and Discord role/channel changes are reconciled with compensation or audit logging where the operation spans both systems.
- All structural operations are recorded in the Postgres audit log.
