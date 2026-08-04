# BAINSA Discord Bot Command Reference

This document describes the v1 command surface implemented by the BAINSA Discord bot.

Cross-university projects are deliberately excluded from v1. Every project belongs to one university and one division.

## How Commands Work

### Where commands can be used

Commands can only be run in a channel named `bot-log`:

- `LOGS / bot-log` for Global Presidents.
- The `bot-log` channel inside a university category for that university's board.

Autocomplete is subject to the same command-channel, board-tier, and university scope checks before the bot queries Postgres or Discord's member directory. An interaction with missing or stale channel/member context, or an unauthorized caller, receives an empty suggestion list.

The bot checks the channel in the dispatcher before running a command. A command copied into another channel is rejected even if a Discord permission is changed manually.

Successful commands that change shared BAINSA state post a concise board-visible activity entry in that `bot-log` channel. The entry records the affected item, scope, meaningful state change, and command actor. Internal notes, removal reasons, and project final notes are never included.

`/guide`, `/member-info`, `/board-info`, `/project-info`, validation errors, failures, and updates that change only private notes remain ephemeral and visible only to the command actor. They are not added to channel history. The PostgreSQL audit log remains the complete technical record.

### Who sees commands

Discord command visibility is synchronized by the bot when `DISCORD_CLIENT_SECRET` is configured. Normal members see no bot commands. The visibility tiers are:

| Tier | Visible commands |
| --- | --- |
| Global President | All commands, with global scope where permitted |
| University President | President commands and all board/project commands |
| University Vice President | Executive member commands and all board/project commands |
| Division Head | Board/project commands; execution is restricted to their division |
| Researcher or Alumni | No bot commands |

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

- University fields search active universities.
- A division field searches only active divisions belonging to the selected university. The division list is empty until a valid university value has been selected.
- Project `members` and `supervisors` fields search Discord server members directly, just like the native member picker used by `/member-add`. They are not filtered by project names, divisions, or university names in the autocomplete UI.
- Project participant fields remain comma-separated string fields because Discord does not provide a multi-user slash-command option. Select or enter one Discord mention at a time, separated by commas. The database validates the final list against the selected project scope.
- Date fields use strict `YYYY-MM-DD` text. Discord slash commands do not provide a native calendar/date option.
- Autocomplete suggestions never include the Bot account.

## Member Commands

### `/member-add`

**Who can use it:** Global Presidents, university Presidents, and university Vice Presidents. The target must belong to the actor's university unless the actor is a Global President.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Discord member to add or initialize |
| `member_type` | Yes | `Researcher` or `Alumni` |
| `university` | Yes | University membership scope |
| `divisions` | No | Comma-separated division names for a Researcher; leave empty for no division |
| `notes` | No | Internal member notes stored in Postgres |

The bot verifies the target, creates or updates the member record, assigns the base member and university roles, assigns Researcher division roles when requested, removes incompatible roles, and records an audit entry. Alumni cannot receive division roles.

### `/member-update`

**Who can use it:** Global Presidents, university Presidents, and university Vice Presidents, subject to university scope.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Existing member to update |
| `member_type` | No | Replacement member type |
| `university` | No | Replacement university; moving a member between universities is a Global President operation |
| `divisions` | No | Replacement comma-separated division list |
| `notes` | No | Replacement internal notes |

The bot updates the database and reconciles Discord roles. Changing a Researcher to Alumni clears division assignments when no replacement divisions are supplied. Existing board assignments must remain compatible with the selected member type.

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

**Who can use it:** Global Presidents and university Presidents for the selected university.

| Field | Required | Meaning |
| --- | --- | --- |
| `university` | Yes | University that owns the new division |
| `division_name` | Yes | New division display name |
| `color` | Yes | One of eight square-icon colors: red 🟥, orange 🟧, yellow 🟨, green 🟩, blue 🟦, pink 🟪, brown 🟫, or black ⬛ |
| `head` | Yes | Discord member who becomes the initial Head |
| `create_text_channel` | Yes | Whether to create the division text channel |
| `create_voice_channel` | Yes | Whether to create the division voice channel |

The bot creates the division record, color-matched access and Head roles, and the requested channels under the university category. It assigns the selected person `Researcher`, the university role, and only the new Head role. The ordinary division access role is intentionally not assigned to a Head. The new Head is also recorded in the board assignments table.

### `/division-rename`

**Who can use it:** Global Presidents and university Presidents for the selected university.

| Field | Required | Meaning |
| --- | --- | --- |
| `university` | Yes | University containing the division |
| `current_name` | Yes | Existing division name to rename |
| `new_name` | Yes | New division name |

The bot validates uniqueness, renames the persisted division, renames the access and Head roles, renames the linked text/voice channels, and records the change. `current_name` is deliberately used instead of `old_name`.

### `/division-add-member`

**Who can use it:** Global Presidents, the selected university's President or Vice President, and the Head of the selected division.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Researcher to add |
| `university` | Yes | University scope |
| `division` | Yes | Division inside the selected university |

The bot verifies that the target can be a Researcher, assigns the university and division access roles, adds the member-division relationship, and records an audit entry.

### `/division-remove-member`

**Who can use it:** Global Presidents, the selected university's President or Vice President, and the Head of the selected division.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Member to remove from the division |
| `university` | Yes | University scope |
| `division` | Yes | Division inside the selected university |
| `reason` | No | Audit and Discord role-removal reason |

The bot blocks removal when the person still has active project access in that division. Otherwise it removes the division relationship and access role while preserving the university membership record.

## Board Commands

### `/board-assign`

**Who can use it:** Global Presidents for all universities; a university President or Vice President for their university. A university President can also assign a co-President; a Vice President cannot assign a President.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Member to appoint |
| `university` | Yes | University board scope |
| `role` | Yes | `Head`, `Vice President`, or `President` |
| `division` | Head only | Required division when assigning a Head; must be empty for Vice President or President |

The bot verifies the appointment, reconciles the Researcher, university, board, and Head roles, records the board assignment, and writes an audit entry. A Head receives only the scoped Head role in addition to the base Researcher and university roles.

### `/board-remove`

**Who can use it:** Global Presidents for all universities; a university President or Vice President for their university. A university President can remove a co-President; a Vice President cannot remove a President.

| Field | Required | Meaning |
| --- | --- | --- |
| `user` | Yes | Board member to update |
| `university` | Yes | University board scope |
| `role` | Yes | Board role to remove |
| `division` | Head only | Specific Head division, or empty to remove all Head roles for that university |
| `reason` | No | Audit and Discord role-removal reason |

The bot deactivates the matching board assignment and removes the managed board role. Base Researcher and university roles remain.

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

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Project name |
| `university` | Yes | University that owns the project; autocomplete searches active universities |
| `division` | Yes | Division inside the selected university; autocomplete is filtered to that university |
| `members` | Yes | One or more server members, entered as comma-separated Discord mentions; final validation requires active Researchers in the selected division |
| `supervisors` | Yes | One or more server members, entered as comma-separated Discord mentions; final validation requires active members of the selected university and permits active Alumni |
| `start_date` | Yes | Start date in `YYYY-MM-DD` format |
| `expected_end` | Yes | Expected end date in `YYYY-MM-DD` format; must not precede the start date |
| `notes` | No | Project notes |

The member and supervisor suggestions search all non-bot Discord members. The selected university and division are still authoritative: the database rejects a person who does not meet the appropriate project eligibility rule, rejects duplicate people across the two lists, and rejects the Bot account. Duplicate mentions within one field are collapsed. A project has at most 994 unique direct participants across members, supervisors, and board liaisons. This reserves six of Discord's 1,000 permission overwrites for `@everyone`, the Bot, Global President, and the scoped Head, Vice President, and President roles. Discord documents this limit as error 30060, “Maximum number of channel permission overwrites reached (1000)”: [Discord API error codes](https://discord.com/developers/topics/opcodes-and-status-codes).

When valid, the bot atomically commits the project, participant records, audit entry, and pending reconciliation intent to PostgreSQL. It then immediately runs an idempotent reconciliation that creates or repairs the private project channel and its scoped access. If Discord work fails, the committed project is reported as pending and retries automatically. The project introduction and showcase history are one-shot best-effort posts; they are not replayed by reconciliation.

### `/project-add-member`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, and the selected project's division Head.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Yes | Visible project selected through autocomplete |
| `user` | Yes | Discord member to add or update |
| `role` | Yes | `member`, `supervisor`, or `board_liaison` |

The bot checks project authority and role-specific eligibility, upserts the participant record, updates the project's direct channel overwrite, and records the change. Only active or paused projects can be changed.

### `/project-remove-member`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, and the selected project's division Head.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Yes | Visible project selected through autocomplete |
| `user` | Yes | Participant to remove |
| `reason` | No | Audit and overwrite-removal reason |

The bot removes the participant record, removes the direct project-channel overwrite, and records the change. Only active or paused projects can be changed.

### `/project-update`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, and the selected project's division Head.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Yes | Visible project selected through autocomplete |
| `name` | No | Replacement project name |
| `expected_end` | No | Replacement ISO date; it must remain on or after the start date |
| `notes` | No | Replacement notes |
| `status` | No | `active` or `paused`; completed projects require `/project-close` |

The bot updates project metadata, renames the project channel when the name changes, updates the project introduction, and records an audit entry. Only active or paused projects can be changed.

### `/project-close`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, and the selected project's division Head.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Yes | Visible project selected through autocomplete |
| `outcome` | Yes | Final project outcome |
| `final_notes` | Yes | Final record and handover notes |

The bot marks the project `completed`, records the outcome and final notes, locks normal project-member sending while preserving read history, updates the project channel with the final summary, and moves the channel into `ARCHIVE / HISTORY`. Only active or paused projects can be closed. There is no separate archive command in v1, and closing a project does not set the database status to `archived`.

### `/project-info`

**Who can use it:** Global Presidents, the selected project's university President or Vice President, the selected project's division Head, and project participants who can view that project.

| Field | Required | Meaning |
| --- | --- | --- |
| `project` | Yes | Project selected through autocomplete; autocomplete only returns projects visible to the caller |

The bot privately shows the project name, university, division, status, timeline, channel, notes, and participant lists.

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
