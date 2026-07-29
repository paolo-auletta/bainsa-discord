# Plan 012: Role-aware private `/guide` command

## Status

Implemented in the working tree on 2026-07-29.

## Purpose

Give each board member a clear, personalised explanation of the bot commands they can currently use. A guide for a Bocconi Head of Culture must show only the workflows and scope available to that person; it must not expose President, Vice President, Global President, or another division's authority.

The guide is a private, ephemeral Discord interaction. It is help, not an activity record, so it must never add a message to `#bot-log`.

## User experience

1. A board member runs `/guide` in a valid university `#bot-log` channel (or the global `#bot-log` where that scope is allowed).
2. The bot replies with one private guide message. Other board members cannot see the response, its buttons, or the user's choices.
3. The message contains a short role-and-scope summary and navigation controls.
4. Selecting a topic updates the same private message in place. Discord does not open a browser-like page or a new chat channel.
5. A **Back** button returns to the previous screen. A fresh `/guide` always starts a fresh guide.

The guide must use a deferred ephemeral reply and message components (buttons and/or a string-select menu). Component interactions update the original guide message instead of sending public messages.

## Guide principles

- Organise content by the job the member wants to complete, not alphabetically by slash-command name.
- State scope in plain language on every relevant screen, for example: `Bocconi > Culture`.
- Use the caller's **effective** access. Multiple roles are combined; the guide is not limited to their highest role.
- Explain both what a command does and the constraints that commonly cause it to fail.
- Say whether a successful operation creates a board-visible activity entry.
- Keep the guide concise at first; command detail is one navigation step away.
- The guide is informational only. It must not become the authorization source of truth; existing server-side authorization still decides every command execution.

## Access calculation

The guide needs a presentation-level access model derived from the caller's current Discord roles and the command-channel scope.

### Required inputs

- Discord member roles from the interaction.
- The current command-channel scope (`global` or a named university).
- The existing university and division naming conventions.
- The existing command visibility and server-side authorization policies.

### Rules

- A Global President receives global authority and the commands available across universities.
- A university President receives their President commands and all lower-tier commands for their university.
- A university Vice President receives executive member-management commands plus all board/project commands for their university.
- A division Head receives only commands permitted to a Head, limited to every division for which they hold a matching Head role.
- A person holding more than one role receives the union of those permissions and scopes.
- A person with no recognised active board role receives a private explanation that no board guide is available; the command must not leak command details.
- Every button/menu interaction recomputes or revalidates current access before rendering the next screen. A stale guide must not preserve access after a role changes.

The guide may show an operation as available only when the role and scope make it generally available. It may still explain data-dependent limits, such as project visibility or member eligibility, rather than pretending they can be decided from roles alone.

## Initial screen

Use a short title, a role summary, and up to four topic controls. The content must fit comfortably in one Discord message.

Example for a Bocconi Head of Culture:

```text
BAINSA Bot Guide

Your access
Head of Culture - Bocconi
You can manage Culture members and Culture projects.

Choose a topic:
[Manage Culture members] [Manage Culture projects]
[Look up information] [Rules and limits]
```

For members with multiple scopes, state all scopes without making the card unreadable. For example: `Head of Culture and Head of Projects - Bocconi`; detailed topic pages state the exact scope of each command.

## Navigation and screen structure

Use one stable message with a small, predictable navigation system:

- **Topic selector:** buttons for the most common topics; a string-select menu can replace or supplement buttons if a role has more than four useful areas.
- **Command selector:** a string-select menu or a compact set of buttons within a topic.
- **Back:** always returns to the previous topic screen.
- **Home:** optional, but useful after the command-detail screen.

The first implementation should avoid a long command list and should not make each command a separate Discord message.

### Topic screens

Topic screens list a small number of outcomes with the corresponding command names. They do not need every field or exception.

Example:

```text
Manage Culture projects

Your scope: Bocconi > Culture

Create a project
/project-create

Change an existing Culture project
/project-add-member
/project-remove-member
/project-update
/project-close

[Project command details] [Back]
```

### Command-detail screen template

Every detail screen must follow this order:

```text
[Plain-language action]
/[command-name]

What it does
[One sentence]

Your scope
[University and division, or global scope]

Before you start
- [Only the key preconditions]

What you provide
- [Required fields in plain language]

What happens after success
- [Discord/record effect]
- [Whether a concise board-log entry is created]

[Back] [Guide home]
```

Use examples only when they remove ambiguity; avoid real member data.

## Content by role

The content is generated from a single command-guide catalogue, filtered by effective access. The catalogue owns display content only; execution authorization remains in services and policies.

### Division Head

For each owned university/division scope, show:

- **Manage division members:** `/division-add-member`, `/division-remove-member` for that Head's division only.
- **Manage division projects:** `/project-create`, `/project-add-member`, `/project-remove-member`, `/project-update`, `/project-close` for that division's projects only.
- **Look up information:** `/member-info` within the university, `/board-info` for the university, and `/project-info` for projects the caller may view.
- **Rules and limits:** cannot manage another division, members, board appointments, or division structure; project members and supervisors must meet eligibility rules.

### University Vice President

Show all Head-level board/project workflows across their university, plus:

- `/member-add`, `/member-update`, `/member-remove` within their university.
- University-wide scope and the restriction that a Vice President cannot manage their university President.

### University President

Show all Vice President workflows across their university, plus:

- `/division-create`, `/division-rename`.
- `/board-assign`, `/board-remove` for Head and Vice President assignments in their university.
- The restriction that only a Global President can appoint or remove a university President.

### Global President

Show all supported workflows across universities and their global scope. Clearly distinguish actions that may target any university from actions that must still name a particular university or division.

## Command-guide catalogue

Create a dedicated catalogue rather than duplicating prose in command handlers. Each guide entry should include:

- Command name.
- Plain-language title and one-line purpose.
- Topic/workflow.
- Required role policy and scope policy.
- Preconditions and key limits.
- Plain-language required and optional inputs.
- Success effects.
- Board-log behaviour (`private`, `public`, or `public-if-visible-fields-change`).
- A stable detail-screen identifier.
- Link/anchor to the longer command reference where helpful.

The catalogue should share role vocabulary with the existing command visibility map where practical, but it must not infer security from display metadata. Missing catalogue metadata for a registered command should fail a focused test or be deliberately excluded with an explicit reason.

## Discord interaction and security requirements

- Register `/guide` with board-level discoverability so eligible board members can find it in their valid `#bot-log`.
- Keep direct messages disabled and preserve the current command-channel restriction unless a later product decision explicitly changes it.
- Reply with `MessageFlags.Ephemeral` from the initial interaction and keep all guide updates private.
- Include only opaque, namespaced component custom IDs; do not encode untrusted prose in custom IDs.
- Treat component values as untrusted. Check that the interacting user and their current roles are authorised for the requested guide view.
- Do not query or expose member/project data merely to build a guide. Use role/channel context; describe data-dependent constraints generically.
- Expired, invalid, or unauthorised component interactions receive a private, short message such as: `This guide is no longer available. Run /guide again.`

## Pinned onboarding message

Pin one short message in each university `#bot-log`:

> Need help with the BAINSA bot? Run `/guide` here. You will only see commands available to you.

Do not pin role-specific command lists; `/guide` is the single current source for personalised help.

## Out of scope

- Changing existing authorization or command visibility rules.
- Sending guide content as a board-visible message.
- Replacing the full documentation in `docs/commands.md`; that document remains the complete reference.
- A web dashboard or browser-style pages.
- Recording guide use in the board-visible activity feed.

## Acceptance criteria

- A Bocconi Head of Culture sees only Head-permitted workflows and only the Bocconi/Culture scope they own.
- A Head does not see President, Vice President, Global President, or another division's actions.
- A multi-role member sees the union of their valid access.
- `/guide`, every detail view, and all validation/failure replies are private and do not add messages to `#bot-log`.
- Navigation updates a single private guide message and includes a usable Back path.
- A guide button interaction rechecks access and never leaks a view after a role change.
- Existing command authorization behaviour remains unchanged.
- Tests cover role/scope filtering, multiple roles, global scope, unauthorised/stale interactions, and no-public-message behaviour.

## Verification

- Add focused unit tests for the catalogue and effective-access calculation.
- Add dispatcher/component tests that prove the guide response and subsequent updates are ephemeral.
- Add tests for a Head of Culture, Vice President, President, Global President, and a multi-role member.
- Run `npm run check`, `npm test`, and `git diff --check`.
