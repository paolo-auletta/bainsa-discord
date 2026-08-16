---
target: "Issue #47 notification and access-transition handoffs"
total_score: 21
max_score: 40
na_heuristics:
p0_count: 1
p1_count: 2
timestamp: 2026-08-12T04-34-26Z
slug: src-services-governance-service-ts
---
Method: dual-agent (A: /root/issue47_design_review · B: /root/issue47_detector_review)

# Issue #47 — notification and access-transition review

## Design-specificity verdict

Partially product-specific. The vocabulary is unmistakably BAINSA—university and division scopes, board roles, `/guide`, project workspaces, native channel links, and pinned records—but the highest-impact transitions still use a generic transactional-DM pattern or are absent. The strongest messages feel Discord-native and operational; board/member messages do not consistently express the smallest useful workspace, the responsibility attached to authority, or what remains after access is removed.

## Implemented versus missing

| Requirement | Status | Evidence |
|---|---|---|
| Board assignment/removal | Partial | Bulk `/board-update` sends post-commit DMs for affected members, but only reports before/after roles and university. Dedicated assignment/removal formatters exist without callers. |
| Member removal | Missing | `/member-remove` commits, cleans up, and kicks without an affected-member handoff; its caller only posts activity afterward. |
| Material access changes | Partial | Onboarding, project assignment/removal, and division membership changes have handoffs. `/member-update` can change member type, university, and divisions but only posts activity and actor confirmation. |
| Role-aware what/scope/spaces/responsibility/next action | Partial | Project assignment is strongest. Board and division messages omit changed spaces and concrete responsibilities; project removal has no next action. |
| Privacy-safe reasons | Partial | Onboarding rejection, division removal, and project removal keep reasons private. Member removal stores a reason in audit but never shares a policy-safe explanation with the affected member. |
| Best effort, no rollback | Implemented for existing handoffs | Board/division delivery happens after mutation and failures become actor warnings; onboarding/projects log failures after commit. |
| Durable recovery | Partial | Onboarding status and project reconciliation are durable, but missed DMs are not recovered by a notification status surface or later reconciliation. |
| Mutation versus delivery truth | Mixed | Board/division actor outcomes distinguish saved state from delivery failure. Project history can claim a direct handoff despite swallowed DM failure. A post-commit kick failure can also prevent the caller from posting activity. |
| Retry idempotency and tests | Missing as a notification contract | `HandoffMessageSpec` has no transition ID, delivery state, or recovery metadata. Tests cover render bounds, onboarding, project assignment, and board bounded delivery, but not the acceptance-gap transitions and retry/privacy matrix. |

## Nielsen design-health score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 2/4 | Some actors see delivery warnings, but missed DMs and member removal have no recipient-visible status. |
| 2 | Match with the real world | 3/4 | BAINSA vocabulary and scope ordering are strong; resulting spaces and responsibilities are under-explained. |
| 3 | User control and freedom | 2/4 | Positive flows have recovery; access-loss messages lack a consistent recourse/help route. |
| 4 | Consistency and standards | 2/4 | A shared primitive helps, but coverage and removal-state language vary. |
| 5 | Error prevention | 2/4 | No-ping, escaping, bounds, and concurrency are good; there is no durable delivery key or replay guard. |
| 6 | Recognition rather than recall | 2/4 | Roles and scopes are named, but users must remember which spaces remain available. |
| 7 | Flexibility and efficiency | 2/4 | Direct links and `/guide` help where present; there is no consistent fallback or notification history. |
| 8 | Aesthetic and minimalist design | 3/4 | Messages are concise, grouped, and capped at three actions; high-stakes states look too similar. |
| 9 | Error recognition and recovery | 1/4 | Failures are often logs only; there is no durable handoff recovery and project history can overclaim success. |
| 10 | Help and documentation | 2/4 | `/guide`, onboarding status, and docs exist, but contextual recovery routes are inconsistent. |
| **Total** |  | **21/40** | **Acceptable, with significant trust and recovery work remaining.** |

## Overall impression

The project has completed the message-system foundation and most common positive/project/division transition paths. It has not yet completed the user-facing contract for authority loss or for every material governance scope change. The central gap is not “can the bot send a DM?”; it is “can a member reliably understand the effective access change, what responsibility it carries, what remains, and how to recover when delivery fails?”

## What is working

- The shared handoff primitive is appropriate for Discord: compact direct messages, native links, no-ping defaults, provenance, and at most three actions.
- Project assignment and onboarding approval communicate useful work: scope, role, direct workspace links, and a concrete first action.
- Board and division panels commit first and report delivery failures without rolling back canonical state; bounded concurrency is tested.

## Priority issues and fixes

### [P0] Member removal is silent and can lose activity after commit

`removeMember` canonicalizes removal, then attempts the kick, but does not notify the affected member. If the kick fails after the database commit, the thrown error can prevent the command caller from posting the mutation activity. Send a policy-safe DM before the kick (or through a stable user reference), persist a removal notification intent with the mutation, and return a structured result that distinguishes canonical removal, DM delivery, and Discord removal. Do not use a post-commit exception that looks like a rollback.

Locations: `src/services/governance/service.ts:632`, `src/commands/governance/index.ts:72`.

### [P1] Material governance access changes are incomplete and board handoffs under-specify effective access

`/member-update` can change university, member type, and divisions without a target handoff. Initial Heads created by division creation and standalone board assignment/removal service paths likewise have no executable notification. Board update copy reports role labels and university but not spaces gained/lost, responsibility, or a guaranteed accessible next action. Derive handoffs from an effective-access diff and tailor removal copy depending on whether another board role remains.

Locations: `src/services/governance/panels.ts:1137`, `src/services/governance/formatters.ts:328`, `src/services/governance/service.ts:798`.

### [P1] Delivery is transient, unaudited, and can be misrepresented

Logs and ephemeral actor warnings are not a durable recovery surface or an idempotent retry boundary. Project history can claim a direct handoff after `notifyAssignments` swallowed a DM failure, and a later reconciliation does not replay the missed notification. Add a durable notification-delivery record keyed by committed transition and recipient, with pending/attempted/delivered/failed states. Retry only undelivered records, and phrase activity as “access changed” unless delivery is authoritative.

Locations: `src/messages/types.ts:158`, `src/services/projects/index.ts:97`, `src/services/projects/index.ts:279`.

### [P2] The renderer can drop recovery content and does not express tone

The bounded renderer consumes sections before later actions, links, and fallback content, so a long message can lose its most important recovery path. `tone` is accepted but not rendered, making success, change, and removal visually identical. Reserve message budget for resulting access, one next action, fallback, and provenance; add a restrained semantic state marker; use removal-specific “What remains”/“If you need help” language.

Locations: `src/messages/render-handoff-message.ts:5`, `src/messages/text.ts:95`, `docs/bot-message-design-system.md:35`.

## Cognitive-load assessment

Moderate load with two checklist failures. Single focus, chunking, grouping, one thing at a time, minimal choices, and progressive disclosure pass. Visual hierarchy fails because tone is unused and title/section headings share the same bold treatment. Working memory fails because board/division recipients must find an unnamed command space and infer what access remains; a removed person may no longer be able to perform the suggested action.

## Emotional journey

Onboarding approval and project joining create a clear arrival peak: the changed state is named, spaces are exposed, and a first action is provided. Authority changes are emotionally flat: before/after role labels do not acknowledge responsibility or closure. Access loss becomes a valley: division/board removal sometimes says base membership remains, project removal has no next step, and full member removal ends in unexplained disappearance. The peak-end experience will remain untrustworthy until removal messages and delivery recovery are explicit.

## Persona red flags

- Jordan, a first-time appointee, is told to find a board command channel rather than given a guaranteed accessible destination; a full removal is silent.
- Riley, stress-testing failure paths, can see contradictory outcomes when DM, reconciliation, or kick delivery fails; retry behavior has no durable idempotency record.
- Casey, on mobile or interrupted, must reconstruct context from the sidebar for board/division messages instead of following a direct link.
- Sam, relying on accessibility support, benefits from linear plain text and explicit labels, but gets no semantic state cue because tone is unused.
- Alex, an operator, has no notification ledger or efficient recovery path for failed handoffs.

## Minor observations

- The design system defines removal as `danger`, while board, division, and project removals use `changed`.
- `formatBoardAssignmentHandoff` and `formatBoardRemovalHandoff` exist without callers, creating apparent rather than executable coverage.
- Division addition and board changes often say “open the space” without a native link.
- Project removal does not state the previous role, remaining visibility, or a next action.
- Structural tests do not verify information priority near the 2,000-character limit.

## Questions for product decisions

1. Should a handoff describe the triggering command, or the recipient’s resulting effective access across all BAINSA scopes?
2. If Discord accepts a DM but the process dies before recording success, what rule prevents both silence and duplicate replay?
3. When someone loses their final board role, what destination can the bot safely link that they can still access?
4. Should removal messages end with “What remains” and “If you need help” rather than “Start here”?
