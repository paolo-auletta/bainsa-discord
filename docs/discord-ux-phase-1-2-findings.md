# BAINSA Discord UX — Phase 1 and 2 Findings

## Scope and method

This report completes the first two steps in the agreed Discord UX plan:

1. Map the core member journeys.
2. Audit the server information architecture.

It is a source-based audit of the implemented Discord structure, interaction code, seeded content,
permissions, and product documentation. It does not yet include observation of a live production
server or interviews with real members. Findings that depend on actual community behavior should be
validated during the later scenario-testing phase.

The experience is treated as a Discord-native product. Its primary mode is **Operate** for bot and
governance workflows, with **Read** moments for onboarding, guidance, announcements, showcases, and
forums. The evaluation preserves the existing BAINSA vocabulary and the principle that work should
remain in the narrowest useful scope.

## Executive conclusion

The underlying organizational model is strong. Global, university, division, project, and governance
boundaries are coherent and unusually well encoded in permissions. The main UX weakness is not the
hierarchy itself; it is the handoff between states. Access appears, disappears, or changes correctly,
but the affected person is often expected to notice the result without a clear arrival, resolution,
or next step.

The second major weakness is uneven forum maturity. `people-directory` has a complete product model:
one reliable entry point, explicit ownership, a controlled taxonomy, canonical bot-managed content,
privacy rules, and a lifecycle. `resources`, `projects-showcase`, and `channel-proposals` are currently
closer to provisioned containers than fully designed community products.

The recommended direction is therefore refinement, not structural replacement:

- Preserve the global → university → division → project hierarchy.
- Design explicit transitions for approval, rejection, new access, project assignment, removal, and
  closure.
- Give each forum its own purpose, post contract, taxonomy, ownership, and lifecycle.
- Separate canonical state from activity history so important information stays easy to find.
- Use the people-directory model as the quality benchmark for every Discord-native workflow.

## Phase 1 — Core member journeys

### Journey 1: New arrival → onboarding → approval

#### Current path

```text
Join server
→ optional welcome DM
→ START HERE / #welcome
→ #onboarding / Begin onboarding
→ name
→ Researcher or Alumni
→ university
→ one division for Researchers
→ review
→ pending university-board decision
→ roles and nickname applied after approval
```

#### What works

- Applicants see a small, read-only starting area instead of the full server.
- The four-step private flow asks only for information needed to establish access.
- Researcher and Alumni paths are clearly separated, and board roles cannot be requested.
- The review queue shows the applicant, path, university, division, prior-removal warning when
  relevant, and a visible review status.
- The authorization model is safe: an applicant cannot use presentation-layer controls to obtain
  broader access.

#### Breaks and friction

1. **The applicant cannot go backward.** After the name modal, every screen offers Continue or
   Cancel, but no Back action. The final review also offers only Submit or Cancel. Correcting an
   earlier answer requires cancelling and restarting the complete flow.

2. **The waiting state is underspecified.** The terminal message says the request was sent for
   review, but does not explain how the applicant will learn the decision, what to do if nothing
   happens, or where to obtain help.

3. **The decision is communicated to the reviewer, not reliably to the applicant.** Approval and
   rejection confirmations are ephemeral responses to the board member. The review card changes in
   a private board channel the applicant cannot see. An approved applicant may receive a best-effort
   people-directory DM, but there is no dedicated approval or rejection notification contract.

4. **Rejection has no member-facing recovery path.** A reviewer may record a reason, but the reason
   is shown on the board review message. The applicant is not told whether they can correct the
   application, contact someone, or reapply.

5. **Approval and directory discovery are coupled in tone.** The current approval DM primarily
   introduces the optional directory. It does not first summarize the member's new university,
   division, unlocked spaces, or recommended first action.

#### Journey conclusion

The application mechanics are sound, but onboarding lacks a designed ending. The highest-value
improvement is an explicit lifecycle with editable review, meaningful pending guidance, and a
member-facing approved or declined resolution.

### Journey 2: Approved member → finding university and division spaces

#### Current path

```text
Approval commits
→ nickname and roles change
→ GLOBAL BAINSA appears
→ one university category appears
→ one division text/voice pair appears for a Researcher
→ member discovers channels through the sidebar and seeded messages
```

#### What works

- Permission layers match the mental model: identity, university, division, project, authority.
- Each university has the same base structure, reducing relearning across chapters.
- Global names are visibly differentiated with the `bainsa-` prefix.
- Division channels use a consistent color icon and name pairing across text and voice.
- The `#welcome` seed explains the narrowest-space rule and the difference between global,
  university, division, and project work.

#### Breaks and friction

1. **There is no personalized arrival after approval.** Many channels appear at once, but the member
   receives no durable summary such as “You joined Bocconi as a Researcher in Analysis; start in
   these three places.”

2. **Guidance is present but not persistently discoverable.** Purpose messages in general,
   announcement, board, onboarding-review, and division channels are not pinned. They will move out
   of view as conversation grows. Only `#bot-log` guidance is explicitly pinned.

3. **Normal text channels have no provisioned channel topic.** The product relies on the first bot
   message rather than Discord's always-nearby channel description to explain purpose and posting
   boundaries.

4. **Order is created but not durably governed.** Initial provisioning creates categories and
   channels in a sensible sequence, but the provisioner does not reconcile positions. Manual moves
   or later additions can gradually make different university areas diverge.

5. **Repeated local names become ambiguous for cross-university officers.** Consistent names such as
   `#general`, `#board`, and `#bot-log` work well for ordinary members who see one university. Global
   Presidents see many identically named channels, raising the risk of acting in the wrong scope.
   This is a navigation problem to solve with scope cues before considering broad renaming.

#### Journey conclusion

The hierarchy is understandable once learned, but activation depends too heavily on users reading
old messages and interpreting newly visible channels. A concise, role-aware arrival message and
persistent channel purpose layer would close most of this gap without changing the server tree.

### Journey 3: Researcher → joining projects and forums

#### Current path

```text
Researcher receives a division
→ can use its text and voice rooms
→ can browse global resources, directory, and showcases
→ board member assigns them to a project
→ private project channel becomes visible
→ project work continues in that channel
```

#### What works

- Project work is correctly separated from university and division conversation.
- Direct participant overwrites avoid permanent project roles and keep access narrow.
- Project creation begins with a structured summary and includes a final review.
- Researchers can browse completed or visible work and discover people through the directory.
- Forum-based knowledge is a sensible response to Discord's channel and role limits.

#### Breaks and friction

1. **Joining a project is operationally silent.** A board member assigns the Researcher and the
   channel appears, but there is no direct member notification, welcome handoff, explanation of
   their project role, or recommended first action. Project history mentions intentionally suppress
   notifications.

2. **There is no discovery-to-participation path.** Members can read showcases, but the experience
   does not explain whether a project accepts interest, whom to contact, or how a Researcher should
   move from seeing work to contributing.

3. **`/project-info` has a confirmed access-contract contradiction.** Documentation says project
   participants can use it, and the service policy can authorize participants. Runtime command
   discovery marks it board-only, while all commands are restricted to `#bot-log`, which ordinary
   participants cannot access. The participant-facing lookup is therefore not reachable.

4. **Forum participation rules are uneven.** The directory has an explicit interaction model, but
   resources and channel proposals provide little structure beyond a short seed message and generic
   tags.

#### Journey conclusion

Researchers have governed spaces but weak activation into them. The product should make project
assignment feel like an intentional handoff, and it must resolve whether project information is a
board tool or a participant capability.

**Redesign decision:** project information is a participant capability inside the project channel.
Project supervisors and scoped board roles can also run project-management commands there. Joining
now includes a direct role-aware handoff, and university showcase replies provide the
discovery-to-participation path. See `docs/discord-ux-journey-3-redesign.md`.

### Journey 4: Alumni → participating without division access

#### Current path

```text
Alumni approval
→ GLOBAL BAINSA and one university area appear
→ no division is required
→ Alumni can join discussion, browse forums, publish a directory profile,
  and potentially supervise a university project
```

#### What works

- Alumni are not forced into an artificial division membership.
- They retain global and university community access.
- The people directory gives Alumni a meaningful, opt-in presence.
- The project model permits active university members, including Alumni, to supervise.

#### Breaks and friction

1. **The Alumni value proposition is implicit.** The interface explains what Alumni are, but not
   how they can contribute: mentorship, resources, introductions, project supervision, or community
   discussion.

2. **Their strongest participation paths are not surfaced.** The directory and potential project
   supervision exist, but approval does not recommend either as a next step.

3. **No division can feel like “less access” without explanation.** The data model correctly omits a
   division, but the experience does not reassure Alumni that this is intentional and show where
   their useful spaces are.

#### Journey conclusion

Alumni access is correctly modeled but weakly activated. A tailored approval and orientation message
can make the role feel deliberate rather than like a reduced Researcher account.

### Journey 5: Board member → managing members, divisions, roles, and projects

#### Current path

```text
Board role assigned
→ private board, onboarding-review, and bot-log access appears
→ /guide explains available workflows and scope
→ commands run in bot-log
→ private acknowledgement returns to actor
→ eligible mutations create one board-visible activity entry
```

#### What works

- `/guide` is role-aware, scope-aware, private, and organized by outcomes rather than one raw
  alphabetical list.
- Authorization is rechecked when components are used, preventing stale guides from preserving
  authority.
- `#bot-log` combines a controlled command location with a human-readable activity history.
- Private notes and reasons are deliberately excluded from board-visible activity messages.
- Pending Discord reconciliation is distinguished from committed database state.
- The activity feed has a stable structure: action, subject, scope, meaningful change, and actor.

#### Breaks and friction

1. **High-impact commands do not share a confirmation standard.** Project creation and profile
   unpublishing have review or confirmation steps, while immediate member removal and several
   authority changes are executed directly from slash-command submission.

2. **The guide's “Members and divisions” topic carries too many mental models.** Membership changes,
   division structure, and board appointments are different jobs. The topic becomes dense for
   Presidents and Global Presidents even though individual detail screens are good.

3. **Generic error handling loses workflow context.** Many failures are accurate strings, but the
   bot-message layer does not consistently state what was preserved, how to correct the input, or
   which action to take next.

4. **Scope is clear inside `/guide`, less clear before every command.** Global Presidents operate
   from one global bot log across all universities; identical university and division selectors
   make final scope confirmation especially important for them.

5. **Board appointment has no member-facing handoff.** Assigning or removing authority changes
   access, but the affected member is not directly told what responsibilities or spaces changed.

#### Journey conclusion

The board experience is the strongest operational journey. Its next improvement is trust design:
consistent previews for consequential changes, clearer recovery, and notifications for the people
whose access or authority changed.

### Journey 6: Project participant → creation → work → closure and archive

#### Current path

```text
Board creates project
→ canonical project record commits
→ private channel is created or queued for reconciliation
→ a pinned project home is created or repaired
→ a tagged university showcase post is created or repaired
→ changes update both canonical messages and add a concise private transition
→ close records a public conclusion and private handover notes
→ channel becomes read-only for members and moves to ARCHIVE / HISTORY
```

#### What works

- Database state and Discord reconciliation are separated correctly, so a Discord failure does not
  create an unsafe duplicate project retry.
- The project wizard maintains a summary and provides Back and Cancel actions.
- Project channels are private and retain readable history after completion.
- Closing requires both a shareable outcome and private final notes.
- Board activity messages accurately distinguish completed Discord work from pending
  reconciliation.

#### Breaks and friction

1. **There is no stable project home.** The introductory summary is a normal unpinned message, and
   later updates append more full summaries. Over time, canonical information becomes mixed with
   conversation and historical snapshots.

2. **Showcase threads accumulate snapshots rather than maintaining one canonical overview.** Updates
   and closure send new messages instead of editing the starter. This makes a project record harder
   to scan and blurs current state with change history.

3. **Provisioned status tags are not used as a lifecycle.** University showcase forums define
   `Active` and `Completed`, but project creation applies only the division tag, and later updates do
   not reconcile status tags.

4. **Showcase creation is one-shot best effort.** If the initial forum post fails after the project
   commits, reconciliation repairs the private channel but intentionally never recreates the
   showcase record. Documentation describes every project as receiving a showcase post, so the
   discoverable record can permanently diverge from the canonical project set.

5. **The archive is intentionally flat.** Every completed project channel moves into one
   `ARCHIVE / HISTORY` category. The documentation already recognizes that this will become hard to
   navigate and consume the server's channel allowance.

6. **Participants lose their only promised lookup.** Because `/project-info` is unreachable for
   ordinary participants, the private channel history is their only source of project state.

#### Journey conclusion

The durable project lifecycle is technically robust, but its information presentation fragments
over time. Projects need one canonical, maintained summary for participants and one canonical,
maintained public-within-scope showcase record.

## Phase 2 — Server information architecture audit

### Current structural model

```text
START HERE
├── welcome
└── onboarding

GLOBAL BAINSA
├── member conversation and voice
├── official announcements
├── cross-university board
├── projects showcase
├── resources
├── people directory
├── channel proposals
└── anonymous feedback

BAINSA <UNIVERSITY>
├── local conversation and voice
├── local announcements
├── board operations
├── bot commands and activity
├── university project showcase
├── onboarding review
└── division text and voice spaces

ARCHIVE / HISTORY
└── completed private project channels

LOGS
├── admin log
└── global bot log
```

### What should remain unchanged

- One shared server rather than separate university servers.
- The global, university, division, and project scope hierarchy.
- A small read-only starting area for applicants.
- Identical base structure across university categories.
- Bot-mediated structural administration and least privilege.
- Private project channels with direct participant access.
- Forums for searchable records and knowledge rather than permanent channels for every topic.
- Existing BAINSA role and governance vocabulary.

### Prioritized IA findings

| Priority | Finding                                                                     | User impact                                                        | Direction                                                                          |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| P1       | Onboarding has no reliable member-facing decision and recovery layer        | Applicants can remain uncertain after submitting or being declined | Design explicit pending, approved, declined, and reapply states                    |
| P1       | `/project-info` is documented for participants but operationally board-only | A promised participant capability is unreachable                   | Decide its intended audience, then align channel entry point, visibility, and docs |
| P1       | The non-directory forums lack distinct content models                       | Posts become inconsistent, hard to filter, and difficult to govern | Give each forum its own template, tags, owner, state model, and archive rule       |
| P1       | Important guidance is not persistent                                        | Members must remember or search for old purpose messages           | Use channel topics, pinned canonical messages, and durable forum guides            |
| P1       | Project and showcase truth fragments into appended snapshots                | Current state becomes harder to find as activity grows             | Maintain canonical summaries separately from chronological activity                |
| P2       | New access and assignments appear silently                                  | Members may miss approvals, project work, or board responsibility  | Add role-aware handoff messages and safe notification rules                        |
| P2       | Consequential commands lack a consistent confirmation contract              | Board members can make high-impact mistakes with little preview    | Define risk tiers and require review for destructive or authority-changing actions |
| P2       | Category and channel positions are not reconciled                           | University structures can drift and lose cross-chapter consistency | Define a durable ordering contract with controlled flexibility                     |
| P2       | The archive is one flat, channel-based collection                           | Navigation and Discord channel limits degrade with growth          | Define retention, grouping, and eventual cold-history strategy                     |
| P3       | Repeated university channel names are ambiguous for global officers         | Cross-university navigation and command scope are error-prone      | Strengthen category, topic, pinned-message, and confirmation scope cues            |

### Forum-by-forum assessment

#### `people-directory` — benchmark

This is the most complete forum experience and should become the internal pattern library. It has:

- A reliable `Start here` entry point.
- Explicit human and bot ownership rules.
- A bounded, governed taxonomy.
- A private authoring flow and clear publication boundary.
- One canonical post per person.
- An update, unpublish, departure, and reapproval lifecycle.
- Automated recovery and unarchive maintenance.

Two later message-system refinements remain: the public profile summary currently says “Your BAINSA
directory profile,” and the public card does not prominently present all useful canonical BAINSA
identity context. These are copy and content-hierarchy issues, not IA failures.

#### `resources` — useful container, incomplete knowledge product

The purpose is valid, but the implemented guidance does not yet define:

- A required title pattern or short “why this matters” summary.
- Resource type, access requirements, source, audience, or expiry fields.
- When a question belongs here versus in global general.
- Who curates duplicates, broken links, outdated opportunities, or unsafe material.
- How posts become verified, outdated, or archived.

Its generic tags (`Projects`, `Research`, `Events`, `Resources`, `Question`) mix content type and topic
and do not cover the richer resource families described in the product guide.

#### University `projects-showcase` — correct purpose, inconsistent record model

The forum correctly separates discoverable project summaries from private working channels. The
main IA problems are:

- Status tags exist but are not applied or updated.
- A thread contains repeated complete snapshots instead of one maintained project overview.
- Initial creation is not durably recoverable.
- The post does not define whether or how interested Researchers may contact the team.
- The boundary between internal notes, shareable progress, and final outcome needs one explicit
  content contract.

#### Global `projects-showcase` — destination without a path

The global forum is read-only and positioned as a curated selection, but v1 has no nomination,
promotion, review, or removal workflow. Its generic global tags are also poorly matched to a forum
where every post is already a project. Until a curation path exists, members see a destination whose
ownership and freshness are unclear.

#### `channel-proposals` — request box without governance states

The implemented guide asks for purpose, audience, and needed help, while the product guide expects a
richer proposal including why existing spaces fail, scope, expected activity, and an owner. The forum
also reuses generic content tags rather than proposal states or scope. It needs at least:

- A proposal template.
- Global, university, and temporary scope.
- Statuses such as `Exploring`, `Trial`, `Approved`, `Declined`, and `Closed`.
- A decision owner and response expectation.
- A trial and inactivity review policy.

### Global versus local placement

The narrowest-useful-space principle is the right primary navigation rule. The current placements
mostly follow it:

- Global discussion, resources, people discovery, network announcements, and proposals belong in
  `GLOBAL BAINSA`.
- University coordination, announcements, showcases, and governance belong in the university.
- Division planning belongs in division rooms.
- Project execution belongs in private project channels.
- Technical and governance history belongs in bot or admin logs.

The unresolved placements are process problems rather than tree problems:

- Cross-university projects have no v1 home by design.
- Global showcase candidates have no promotion path.
- Channel proposals can request a local space but are housed only in a global forum.
- Completed project channels outgrow a single archive category.

### Can members understand the server without asking someone?

**Applicants:** mostly yes before submitting, but not after entering the pending state.

**New Researchers:** they can infer the hierarchy, but they are not told which newly unlocked spaces
matter first or how project participation begins.

**Alumni:** they can find the available spaces, but the product does not explain their intended
contribution model.

**Board members:** `/guide` makes the command system understandable, though high-impact action and
scope confirmation need refinement.

**Global Presidents:** they have the greatest navigation burden because they see repeated local
channel names and operate across all scopes from one command channel.

Overall, members can learn the server, but too much depends on passive discovery. The design should
move from “the correct space exists” to “the correct next space is introduced when it becomes
relevant.”

## Design direction for the next phase

### Structural thesis

BAINSA should feel like one association that reveals the smallest useful workspace for each person.
The bot is not only an administrator; it is the transition guide between those workspaces.

### Interaction thesis

Every meaningful transition should answer five questions:

1. What just happened?
2. What scope does it affect?
3. What can the person do now?
4. What remains private or pending?
5. What is the next best action?

### Content thesis

Every long-lived Discord surface should have one canonical source of current truth and, only where
useful, a separate chronological activity history. Current state should not need to be reconstructed
from a stream of old messages.

### Forum thesis

Every forum must define five things before its messages are polished:

1. The unit of a post.
2. The required post structure.
3. The taxonomy and lifecycle states.
4. The owner of creation, moderation, and closure.
5. The relationship between the forum record and operational conversation elsewhere.

## Recommended order for the joint design work

1. Create the shared bot-message system and transition-state language.
2. Apply it first to onboarding approval, rejection, waiting, access assignment, and project joining.
3. Resolve the `/project-info` participant contract.
4. Design forum operating contracts for resources, university showcase, global showcase, and channel
   proposals.
5. Design persistent channel guidance and role-aware arrival messages.
6. Define the canonical project-home and showcase-summary model.
7. Decide archive retention and scaling rules.
8. Validate the revised journeys with realistic applicant, Researcher, Alumni, board, and project
   scenarios.

## Decisions to make together

The evidence leaves three product decisions that should not be invented during implementation:

1. **Applicant decisions:** Should approval and rejection always be sent by DM, or should the product
   also provide a reliable in-server status surface when DMs are closed?
2. **Project participation — resolved:** `/project-info` is available in project channels to every
   participant; supervisors and scoped board roles can run the management commands there.
3. **Showcase philosophy — resolved for the university layer:** every internal project has one
   maintained university showcase record. Its canonical starter is shareable; internal work and
   handover notes remain in the private project channel.
