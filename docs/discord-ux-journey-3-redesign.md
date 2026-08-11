# Journey 3 Redesign — Researcher → Projects and Forums

## Outcome

Joining a project should feel like entering a deliberate workspace, not noticing that another
channel appeared. The redesigned journey gives each project two maintained surfaces:

```text
Private project channel                         University projects showcase
Operational home                               Shareable record
├── pinned project record + workspace guide      ├── one bot-owned canonical starter
├── private discussion, drafts, and decisions  ├── division + lifecycle tags
├── project-scoped commands                    ├── shareable progress and files in replies
└── chronological transition messages          └── questions and contribution interest
```

PostgreSQL remains the source of truth. Reconciliation maintains both canonical Discord records;
human replies remain chronological content and are never overwritten.

## How the redesign resolves the findings

### 1. Project assignment becomes an intentional handoff

Every newly assigned member or supervisor receives a direct message after Discord access is ready.
It states:

- the project, university, and division;
- their project role;
- a direct link to the private workspace;
- a direct link to the shareable showcase record;
- one role-aware first action.

The private channel also receives a compact team-change message. It does not repeat the full project
record or generate a notification ping. Removal receives the same transition treatment: the affected
person is told that access changed, while any supplied reason remains private to them and the audit
record.

### 2. Discovery now has a participation path

The showcase is no longer a read-only display. University members may reply inside an existing
project post, attach files, embed links, react, ask a relevant question, or express a concrete
interest in contributing. Only the bot may create project posts.

Active records explicitly invite a useful question or contribution idea and point Researchers to
the project supervisors. Completed records retain their public conclusion and shareable materials.
Drafts, internal decisions, private notes, and handover details remain in the private workspace.

### 3. Project information and management live where the work happens

The following commands may be run inside a private project channel:

| Caller | Available behavior |
| --- | --- |
| Any project participant | `/project-info` |
| Project supervisor | `/project-info`, `/project-update`, `/project-close` |
| Scoped board role | The same management commands for projects in their authority scope |

The `project` selector is optional inside a project channel and is inferred from the bot-managed
channel topic. If a project is supplied explicitly, it must match the current channel. In `#bot-log`,
the selector remains necessary.

Discord command visibility is only a presentation layer. Participant visibility, supervisor status,
project identity, lifecycle state, university, and division authority are rechecked from current
server and database state when the command executes and again at the transactional write boundary.

A mutation run in the project workspace creates its human-facing transition there, while the
governance activity entry is still routed to the owning university’s `#bot-log`.

### 4. The showcase gets an explicit operating contract

The forum guide now defines:

- **Unit:** one bot-created post per project.
- **Canonical content:** the bot-owned starter message.
- **Chronology:** human replies, progress notes, questions, links, and files below it.
- **Taxonomy:** one division tag plus exactly one lifecycle tag: `Active`, `Paused`, or `Completed`.
- **Ownership:** the bot creates and maintains records; university members may reply but not create
  showcase posts.
- **Privacy boundary:** internal work and handover information never enter the showcase.

Discord applies reply permission at the forum level, not per forum post. It therefore cannot grant
native reply access only to the participants of one project without also granting that access in the
other posts they can view. The redesign uses that platform constraint deliberately: all university
members may reply, which also creates the missing discovery-to-participation path. The locked
`Start here` post keeps the guide itself read-only.

## Project home message system

The project channel opens with two pinned bot messages: a canonical project record, stored by Discord
message ID and edited in place, followed by a normal-text workspace guide with its own durable message
identity. The project record's information order is:

1. Project name and private-workspace scope.
2. Public project summary.
3. Status, division, and timeline.
4. Members, supervisors, and any board liaisons.
5. Private internal working notes, when present.
6. On completion, the public conclusion and private internal handover notes.

The separate workspace guide tells every participant where to keep private work, how to inspect the
record, and which project-scoped commands supervisors and scoped board can run in the channel.

Bot-generated changes use a smaller transition-message pattern with a single event title, the
meaningful change, its consequence, and a reminder that the pinned overview is current. Full project
snapshots are no longer appended after every update.

## Showcase record and closure

The bot edits the existing showcase starter instead of adding another full snapshot. Its hierarchy
is:

1. Project name and public summary. Private working notes never enter this surface.
2. Status, division, and timeline.
3. Contributors and supervisors.
4. Active participation guidance or the completed public conclusion.
5. A reminder that internal handover information remains private.

Ongoing project context follows the same boundary:

| Field | Meaning | Project home | Showcase | `#bot-log` on change |
| --- | --- | --- | --- | --- |
| `summary` | Public explanation of the project and why it matters | Yes | Yes | Change recorded |
| `notes` | Private working context for the assigned team | Yes | No | No |

Closure gives its two required fields distinct jobs:

| Field | Meaning | Visible in project home | Visible in showcase | Visible in `#bot-log` |
| --- | --- | --- | --- | --- |
| `outcome` | Public conclusion: what the project delivered, learned, or decided | Yes | Yes | Yes |
| `final_notes` | Private handover: ownership, follow-ups, caveats, and internal continuity | Yes | No | No |

After closing, reconciliation applies the `Completed` tag, moves the private channel to
`ARCHIVE / HISTORY`, makes it read-only for ordinary members, preserves supervisor and scoped-board
handover access, and updates both canonical records. The completion transition contains the public
conclusion but never repeats the private handover notes.

## Reliability model

The canonical private overview and showcase starter are desired Discord state, not one-shot history.
Creating, updating, pausing, changing the team, or closing a project advances the project’s existing
generation-numbered reconciliation. A missing project home, missing showcase post, stale starter,
wrong title, or wrong lifecycle tags is repaired by retrying the latest generation.

Migration 018 queues every existing project, including completed work, for a fresh reconciliation
generation so each project adopts or creates both canonical records after deployment.

Showcase reconciliation is required. If a university has no configured showcase forum, the
configured forum is missing, or the configured channel is not a forum, reconciliation fails and
remains retryable instead of completing without the public canonical record.

Direct handoff DMs and chronological transition messages remain best effort because replaying them
would create duplicate human notifications. Their delivery failure does not roll back a committed
project mutation.
