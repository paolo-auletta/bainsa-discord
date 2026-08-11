# Bot message design system

## Principle

Choose the primitive from the message's purpose. Do not choose it from the command that happens to
send the message, and do not turn every response into the same visual object.

All new output is described with a semantic contract and rendered by `src/messages/`. Domain code
owns the facts and privacy decision; the shared layer owns Discord builders, semantic colors,
spacing, field order, component limits, provenance, and no-ping defaults.

## Primitive decision table

| Primitive | Use when | Discord form | Required structure |
| --- | --- | --- | --- |
| Event card | A shared-state event belongs in chronological activity, or a transient lookup needs a compact read-only summary | Embed | Semantic marker/color, title, subject, ordered details, and event-only state/actor fields when applicable |
| Workspace document | People will return to a canonical record or guide | Plain text | Title, metadata, sections, quiet provenance footer |
| Interaction panel | The actor must choose, confirm, wait, recover, or see a private outcome | Components V2 | Accent, title/context, optional facts/progress, controls/actions, status |
| Handoff message | A change affects a person who needs context and a next action | Plain DM | Direct title, changed access/context, private details when allowed, up to three next actions, links |

`renderBotMessage` accepts the union contract when the caller needs polymorphism. Domain-specific
formatters can call `renderEventCard`, `renderWorkspaceDocument`, `renderInteractionPanel`, or
`renderHandoffMessage` directly.

## Shared semantics

### Tones

| Tone | Meaning | Typical examples |
| --- | --- | --- |
| `brand` | Informational BAINSA context or completed lifecycle transition | Guide, closed project |
| `success` | Addition or completed action | Assignment, approval, created project |
| `pending` | Saved work still processing or an operation in progress | Project saving, Discord reconciliation |
| `warning` | Consequential choice or recoverable attention | Removal confirmation, expired state |
| `changed` | Existing state changed without being removed | Project update, role change |
| `danger` | Removal, validation failure, or unsuccessful action | Role removal, rejected input |
| `neutral` | Cancellation or no visible change | Cancelled setup, notes-only update |

Colors and event markers live in `src/messages/tokens.ts`. Callers pass a tone; they do not pass a
hex color or choose an arbitrary emoji.

### Safety and limits

- Every rendered payload defaults to `allowedMentions: { parse: [] }`.
- User-authored plain-text values must pass through `escapeUserText` before being placed inside
  Markdown. Native user and channel references use `userReference` and `channelReference`.
- Event cards enforce the 6,000-character aggregate embed limit and fixed field order.
- Workspace documents and handoffs fit in one 2,000-character message and retain their provenance
  footer when content is shortened.
- Interaction panels bound text displays, custom IDs, select options, controls, action rows, and the
  ten-child container limit.
- Private reasons and internal notes are decided at the domain boundary. A renderer does not make
  private information safe for a broader audience.

## Payload contracts

### Event card

Use one card for one event or one compact transient lookup. The renderer always orders visible fields as:

1. Subject.
2. Scope.
3. Domain details.
4. Result.
5. Discord state.
6. Performed by.

Do not put instructions, long explanations, internal notes, or private removal reasons in an event
card. Event cards omit inapplicable event fields. `/member-info` pairs Member with Type and
University with Divisions, then gives board roles and active projects full-width rows. Empty
assignment groups use an explicit `No active…` value so the result is unambiguous.

### Workspace document

Use a document for canonical project records, their private `/project-info` projection, showcase
starters, guides, and durable workspace instructions. Project documents keep scope above workspace
links, team, public narrative, and explicitly labelled authorized internal context. Showcase
projections omit private links and internal context at the formatter boundary. Other transient
private lookups are not workspace documents. Canonical records are edited in place; chronological
transitions remain separate event cards. End every document with provenance such as:

```text
-# Project #42 · Pinned project record · Updates automatically
```

### Interaction panel

Use a panel for actor-only work: guide navigation, confirmation, progress, validation, success,
no-change, stale, busy, reconciliation-pending, and delivery-failed states. Use `interactionOutcome`
for terminal outcomes so titles and tones stay consistent.

Every input has its field label and optional explanation immediately above the control. Put editable
body actions, such as opening a prefilled text modal, beside the inputs they affect. Reserve the
footer action row for flow navigation: continue, back, cancel, and final confirmation.

Selection steps keep the chosen value visible and require an explicit Continue action before an
expensive lookup or scope check changes the screen. Update steps show one current-state summary;
only changed fields expand to `Current → New`. When an `-info` command exists, its canonical summary
formatter is the single source for that update summary; panels use the compact density rather than
maintaining a second set of labels or facts.

Use compact groups when a record mixes distinct kinds of information. Keep rows tight inside each
group and leave one blank line between identity/scope, links, people, and narrative or private
content. Do not add a redundant group heading when the row labels already identify the content.

After Continue, keep member and project update selection screens in place while their lookup runs.
Change Continue to a disabled `Loading…` state and temporarily disable the other controls, then
replace the same private response with the next step or a recoverable error. Full loading panels
remain appropriate for consequential saves and operations whose context screen should no longer be
interactive.

Consequential operations must bind their custom IDs to a server and actor, expire old sessions,
disable or remove actions while busy, and avoid offering a retry after the database has committed.

### Handoff message

Use a handoff after onboarding decisions, project assignments/removals, and board access changes.
Lead with what changed, name the scope and role, then give at most three concrete next actions. A
private reason may appear only in the affected person's DM and the audit record—never in the shared
event card.

## Current migration boundary

The shared Interaction Panel component exists and is used for `/guide`, generic private outcomes,
division creation and updates, member updates, board/division membership management, project updates
and closure, project-saving progress, and project creation success/failure. Division, member, and
project management flows compose the same labeled controls, body actions, summary rules, and footer
navigation instead of building one-off Components V2 containers.

| Membership command | UI contract | Database-derived context |
|---|---|---|
| `/board-update` | Paginated roster editor | University, every active division, current-to-new position holders, and hierarchy-safe controls |
| `/division-add-member` | Migrated member-first panel | University, member type, current memberships, and actor-manageable divisions |
| `/division-remove-member` | Migrated member-first panel | University, every membership, scope, Head/project requirements, and remaining-division invariant |
| `/member-remove` | Pending panel migration | Existing inline target and reason remain until its dedicated slice |

Discord string-select options have no per-option disabled state. Removal panels therefore show the
complete role or division state in the summary with `Removable`, `Read only`, or `Blocked` labels,
then include only actionable records in the selector.

The existing step, navigation, and review screens inside these three creation wizards intentionally
remain unchanged for this migration:

- onboarding;
- profile creation/editing;
- project creation scope, participants, details, and review.

Their terminal or standalone states may use the shared panel where explicitly implemented, but a
future migration must treat each wizard as a complete interaction redesign rather than replacing
individual screens opportunistically.

## Adding a message

1. Identify the audience and whether the message is event history, a durable record, an actor
   interaction, or a personal handoff.
2. Build the corresponding semantic spec in the domain formatter. Escape user-authored Markdown
   and exclude data the audience must not see.
3. Render it through `src/messages/`; do not instantiate Discord embed or Components V2 builders in
   the domain module.
4. Deliver it through the shared reply helpers when it is an interaction response.
5. Add a structural test for the primitive, semantic tone, order, privacy boundary, no-ping policy,
   and relevant Discord limits.
