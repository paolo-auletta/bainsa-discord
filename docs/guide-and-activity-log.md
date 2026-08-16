# Role-Aware Guide and Board Activity Log

## Purpose

This document preserves the product and security contract implemented by the private `/guide`
experience and the board-visible `#bot-log` activity feed. The guide explains what the caller can
do; the activity feed records successful shared-state changes. Neither replaces server-side
authorization or the durable PostgreSQL audit log.

## `/guide` contract

`/guide` is a private, ephemeral interaction for board members. It starts in a valid global or
university `#bot-log`, renders one message, and updates that message in place as the caller selects
topics or command details. It must not create a normal channel message or an activity entry.

The guide is organized by jobs rather than an alphabetical command list. Member management,
division management, and board appointments are separate topics; projects, lookups, and rules
remain separate supporting topics. Every command detail states the caller's scope in plain
language, such as `Bocconi > Culture`, then explains prerequisites, inputs, confirmation and
safeguards, success effects, and the recovery route if the workflow cannot continue.

### Effective access

Guide content is derived from the interaction's current channel scope and current Discord roles:

- A Division Head sees member and project workflows only for each division they lead, plus the
  permitted university/project lookups.
- A university Vice President sees the Head-level workflows across that university and the
  university member-management commands. They cannot manage their university President.
- A university President also sees division creation/rename and Head/Vice President appointment
  workflows for that university.
- A Global President sees supported workflows across universities, while commands that operate
  on a specific university or division must still name that scope.
- Multiple valid roles produce the union of their permissions and scopes.
- A caller without a recognized active board role receives a private generic explanation, not a
  list of protected commands.

The guide catalogue is display metadata only. It must not authorize command execution. Component
interactions revalidate access so an old guide cannot retain authority after a role change.
Custom IDs are opaque and namespaced; component values are untrusted. Expired, invalid, or
unauthorized interactions receive a short private response directing the user to run `/guide`
again.

### Content and navigation

The home view contains a compact role/scope summary and a small topic selector. Topic views keep
member management, division management, and board appointments distinct, then group projects,
lookups, and rules or limits separately. Command detail views use this order:

1. Plain-language action and slash-command name.
2. What the command does.
3. The caller's applicable scope.
4. Key prerequisites and constraints.
5. Required and important optional inputs.
6. What the final review confirms, or whether the command acts immediately.
7. State, Discord, audit, and activity-feed effects after success.
8. What remains unchanged after a failed validation, authorization, or stale-state check, and
   where to resume safely.
9. Back and guide-home navigation.

Provisioning maintains one pinned message in each university `#bot-log` telling board members to
run `/guide`. It must not pin role-specific command lists, because those become stale and can
expose actions outside a member's current scope.

## Board-visible activity contract

After a command successfully changes shared BAINSA state, the bot posts exactly one concise,
structured entry to the relevant board-visible `#bot-log`. The command invocation is not the
record; the final result is posted only after the operation reaches the success state described by
the entry.

Read-only commands, `/guide`, autocomplete, failures, validation errors, and updates that change
only private notes remain ephemeral. PostgreSQL `audit_log` is the complete technical record; the
Discord feed is a curated human-readable summary.

### Message shape

Entries consistently contain:

1. A stable action title and icon.
2. The affected member, division, appointment, or project.
3. University and division scope when applicable.
4. Only the meaningful visible details of the resulting change.
5. `Performed by @actor`.

Use `🟢`/green for create, add, and assign; `🟠`/orange for update, rename, and move;
`🔴`/red for remove; and `🔵`/brand blue for close or complete. Discord's own timestamp is
sufficient. Update entries show only actual visible differences as `old -> new`. The shared event
renderer owns the marker, color, and fixed field order; domain formatters supply semantic facts.

Formatters accept already-authorized success results and return bounded Discord payloads. They do
not authorize, mutate state, or accept private note/reason fields. Participant lists and all fields
must be shortened safely before reaching Discord limits.

### Command policy

| Command or outcome | Activity entry | Visible content |
|---|---|---|
| `/member-update` | Only for type, university, or division changes | Member, scope, and each visible `old -> new` change |
| Member notes-only update | Never | Durable audit only |
| `/member-remove` | Always after success | Member, university, and that the member was removed from the server |
| `/member-info` | Never | Private lookup |
| `/division-create` | Always after success | Division, university, initial Head, and created text/voice channels |
| `/division-update` | Always after success | University and changed division name or color |
| `/division-add-member` | Always after success | Member and university/division scope |
| `/division-remove-member` | Always after success | Member and university/division scope |
| `/board-update` | Always after success | University and every board position changed from current to new members |
| `/board-info` | Never | Private lookup |
| `/project-create` | Always after success | Project, scope, team, timeline, and created channel |
| `/project-update` | For visible project or team changes | Project, scope, visible `old -> new` changes, participant additions/removals, and role changes |
| Project notes-only update | Never | Durable audit only |
| `/project-close` | Always after success | Project, scope, shared outcome, completed status, and archive/history channel |
| `/project-info` or `/guide` | Never | Private response |

### Privacy boundary

Never include internal member notes, removal reasons, division-removal reasons, board-role-removal
reasons, project notes, project final notes, raw database IDs, stack traces, exception details, or
reconciliation diagnostics in a board-visible entry. A project close may show the shared recorded
outcome, but not private final notes.

### Recovery messages

Private recovery panels use one fixed order so a stressed board member can scan them quickly:

1. **What happened** — a concise, user-safe reason; never an internal exception or audit detail.
2. **What was preserved** — the canonical state or staged work that did not change.
3. **How to correct it** — the concrete condition to fix, refresh, or delegate.
4. **Where to continue** — the safe prior step, retry, command restart, or operator escalation.

Validation, authorization, and stale-control failures must say that no shared change was made.
Panel save failures additionally state that the proposed setup, roster, or membership choice remains
available. A committed change with pending Discord reconciliation instead says that the canonical
record remains saved and explicitly tells the actor not to repeat the completed mutation.

Recovery panels are private. They must not disclose private notes, reasons, protected assignment
data, reconciliation diagnostics, or internal audit information.

### Partial Discord outcomes

The activity message must match the real result. If domain state committed but a Discord change is
pending reconciliation, do not claim that the Discord channel or permissions already changed.
Either describe the accepted pending state accurately or wait until the product's success
semantics permit the final entry. A rejected or failed mutation must never produce a false success
message.

## Regression coverage

Tests should continue to cover effective access for every board tier, multiple roles, global and
university scopes, stale component interactions, ephemeral-only guide behavior, every activity
policy row, notes-only suppression, privacy exclusions, Discord length bounds, and no-post behavior
for failures or pending outcomes.
