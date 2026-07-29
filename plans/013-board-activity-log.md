# Plan 013: Board-visible activity log for successful changes

## Purpose

Make the university `#bot-log` a readable, shared record of meaningful changes made through the bot. Board members should be able to see what changed, where it changed, and who performed the action without the channel becoming a stream of private lookups, help screens, or validation errors.

The channel is board-visible rather than publicly visible to the whole server. Nevertheless, it should avoid unnecessary exposure of sensitive free text.

## Product rule

- A successful command that changes shared BAINSA state creates one concise, normal Discord message in the relevant `#bot-log`.
- Read-only commands, `/guide`, failures, validation errors, and private-note-only changes produce only an ephemeral reply to the caller.
- The PostgreSQL audit log remains the complete technical record. The Discord entry is the human-readable board feed, not a replacement for audit data.

The slash-command invocation itself is not the activity record. The bot posts the final confirmed result only after the operation succeeds.

## Message design system

Use a consistent Discord embed-style message for every visible action.

### Required order

1. **Action title:** what happened, with a stable icon.
2. **Affected item:** member, division, board appointment, or project.
3. **Scope:** university and division when applicable.
4. **Meaningful details:** the exact state created, removed, or changed.
5. **Actor:** `Performed by @actor`.

Discord's native message timestamp supplies the time; do not repeat it as a separate field unless a future audit requirement needs an explicit date.

### Action vocabulary and colour

| Kind | Icon | Colour | Example title |
|---|---|---|---|
| Create, add, assign | `➕` | Green | `Project created` |
| Update, rename, move | `✏️` | Amber | `Member updated` |
| Remove, revoke | `➖` | Red | `Board role removed` |
| Complete/close | `✅` | Blue or purple | `Project closed` |

Use these words consistently. Do not mix `deleted`, `kicked`, `revoked`, and `removed` for the same operation unless the underlying effect is materially different and worth explaining.

### Standard layout

```text
[icon] [Action title]
[Affected item]

Scope
[University] > [Division, when applicable]

[One or more action-specific fields]

Performed by @actor
```

Keep titles and descriptions short. Use fields for structured information rather than paragraphs.

### Privacy boundary

Never include the following in the board-visible message by default:

- Internal member notes.
- Member-removal reasons.
- Division-removal reasons.
- Board-role-removal reasons.
- Project notes.
- Project final notes.
- Raw database IDs, exception details, or reconciliation diagnostics.

These values continue to be available to authorised operators through the database audit trail where recorded. Public activity entries may state that a reason or note was recorded without revealing it, but normally should omit that entirely to avoid noise.

## Command-by-command policy

All messages below also include **Performed by @actor**.

| Command | Board-visible policy | Required visible content |
|---|---|---|
| `/member-add` | Always after success | Member, member type, university, initial division(s) if any |
| `/member-update` | Only if type, university, or divisions change | Member, scope, each visible change as `old -> new` |
| `/member-update` with notes only | No board message | Database audit only |
| `/member-remove` | Always after success | Member and university; state that the member was removed from the server; no reason |
| `/member-info` | Never | Private lookup only |
| `/division-create` | Always after success | New division, university, initial Head, whether text and/or voice channels were created |
| `/division-rename` | Always after success | University and `old division name -> new division name` |
| `/division-add-member` | Always after success | Member and `university > division` |
| `/division-remove-member` | Always after success | Member and `university > division`; no reason |
| `/board-assign` | Always after success | Member, assigned role, university, and division for a Head appointment |
| `/board-remove` | Always after success | Member, removed role, university, and division if relevant; no reason |
| `/board-info` | Never | Private lookup only |
| `/project-create` | Always after success | Project name, scope, members, supervisors, timeline, created channel; no notes |
| `/project-add-member` | Always after success | Project, scope, person, and project role; if an existing role changed, show `old -> new` |
| `/project-remove-member` | Always after success | Project, scope, person removed; no reason |
| `/project-update` | Only if name, expected end, or status changes | Project, scope, and each changed visible field as `old -> new` |
| `/project-update` with notes only | No board message | Database audit only |
| `/project-close` | Always after success | Project, scope, recorded outcome, completed status, and archive/history channel; no final notes |
| `/project-info` | Never | Private lookup only |
| `/guide` | Never | Private guide only |

This produces fourteen meaningful activity classes. The two conditional update commands intentionally suppress log messages when only a private text field changed.

## Message templates

### Member added

```text
➕ Member added
@Luca - Researcher

Scope
Bocconi > Culture

Performed by @Maria
```

If a member has more than one initial division, list them in one compact field. If the member has none, show only the university scope.

### Member updated

```text
✏️ Member updated
@Luca

Scope
Bocconi

Changes
- Divisions: Culture -> Culture, Projects
- Member type: Researcher -> Alumni

Performed by @Maria
```

Only render fields actually changed. If a Global President moves a member between universities, include `University: Bocconi -> Sapienza` and the resulting division state.

### Member removed

```text
➖ Member removed
@Luca

Scope
Bocconi

The member was removed from the server.

Performed by @Maria
```

### Division created or renamed

```text
➕ Division created
Culture

Scope
Bocconi

Initial Head
@Anna

Channels created
Text: Yes - Voice: Yes

Performed by @Maria
```

```text
✏️ Division renamed

Scope
Bocconi

Change
Analysis -> Research

Performed by @Maria
```

### Division membership changed

```text
➕ Division member added
@Luca

Scope
Bocconi > Culture

Performed by @Maria
```

For removal, use `➖ Division member removed` with the same fields.

### Board role assigned or removed

```text
➕ Board role assigned
@Anna

Scope
Bocconi > Culture

Role
Head of Culture

Performed by @Maria
```

For Vice President and President actions, scope is the university only. For removals, use `➖ Board role removed`.

### Project created

```text
➕ Project created
Spring Festival

Scope
Bocconi > Culture

Project team
Members: @Luca, @Giulia
Supervisors: @Anna

Timeline
01 Sep 2026 -> 15 Dec 2026

Channel
#project-spring-festival

Performed by @Maria
```

Use Discord mentions and channel mentions where available. If a project has a large team, use a compact count plus a limited list and a clear overflow indicator rather than producing an oversized message.

### Project participant changed

```text
➕ Project participant added
Spring Festival

Scope
Bocconi > Culture

Participant
@Luca - Member

Performed by @Maria
```

When `/project-add-member` changes an existing participant's role, use `✏️ Project participant updated` and show `Role: Member -> Supervisor`. For removal, use `➖ Project participant removed`.

### Project updated

```text
✏️ Project updated
Spring Festival

Scope
Bocconi > Culture

Changes
- Expected end: 15 Dec 2026 -> 22 Dec 2026
- Status: Active -> Paused

Performed by @Maria
```

Never include project notes. A name change must show the old and new project names.

### Project closed

```text
✅ Project closed
Spring Festival

Scope
Bocconi > Culture

Outcome
Event delivered successfully

Channel
Moved to #archive-history

Performed by @Maria
```

Show the recorded outcome because it describes the shared end state. Do not show the free-text final notes.

## Delivery behaviour

1. Command handler begins with a private, deferred acknowledgement as it does today.
2. The service completes database and Discord work according to existing success/reconciliation semantics.
3. Only after the operation is accepted as successful does the command send its board-visible activity entry to the relevant `#bot-log`.
4. The caller receives a short ephemeral confirmation, for example: `Activity posted in this channel.`
5. A command that is read-only, fails, or qualifies as a notes-only update returns its result privately and sends no board message.

The public message must not be sent before an operation that can still fail. If an existing operation reports a pending reconciliation state, the message must describe that state accurately instead of falsely claiming a channel/role change is already complete.

## Formatting architecture

Create a dedicated formatter layer for activity entries instead of assembling ad hoc success strings in every command handler. Each formatter should receive an already-authorised success result and return a message payload.

The formatter layer should:

- Choose the stable action title, icon, and colour.
- Normalise mentions and display labels.
- Render only changed fields for updates.
- Enforce the privacy allow-list by not accepting internal note/reason fields in public templates.
- Bound field/message lengths and participant lists to Discord limits.
- Return `null` for an intentionally private result, such as a notes-only update.

Keep mutation, audit, Discord provisioning, and activity-message formatting separate. The activity formatter must not decide whether an actor is authorised or change state.

## Out of scope

- Exposing the raw PostgreSQL audit log in Discord.
- Posting failed attempts, autocomplete activity, `/guide` use, or read-only command usage.
- Publishing internal notes, reasons, final notes, raw IDs, or stack traces.
- Changing command permissions, authorization, or project visibility.
- Creating a separate audit channel unless a later product decision requests one.

## Acceptance criteria

- Every eligible state-changing command creates exactly one board-visible entry after success, except notes-only updates.
- `/member-info`, `/board-info`, `/project-info`, `/guide`, errors, and notes-only updates create no `#bot-log` message.
- Every visible entry names the action, affected item, scope, actor, and the relevant state details.
- Update entries show only actual visible differences as `old -> new`.
- Free-text notes and reasons never appear in the board-visible entry.
- Project creation and closure entries include the agreed project-specific information without exceeding Discord limits.
- A failed command produces no false success log entry.
- Existing audit records remain intact and no authorization behaviour changes.
- Tests cover every command policy, conditional updates, privacy exclusions, message shape, length bounds, and failure/no-post behaviour.

## Verification

- Add unit tests for each activity formatter and its privacy exclusions.
- Add command tests proving whether each command emits a normal channel message or only an ephemeral reply.
- Add regression tests for notes-only member and project updates.
- Add an integration-style test ensuring activity messages are not sent when a mutation fails or is reported as pending.
- Run `npm run check`, `npm test`, and `git diff --check`.
