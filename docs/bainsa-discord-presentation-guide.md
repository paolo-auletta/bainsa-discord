# BAINSA Discord: presentation and operating guide

## 1. Opening: the idea behind the Discord

BAINSA is changing from one association into a network of university chapters. That creates a design challenge: we need the benefits of one shared community without turning every local decision into a global decision.

The Discord server is designed as the digital operating system for that structure. It gives every university its own working space, while connecting all approved members through a smaller set of global channels. The bot then turns the governance model into permissions: it onboards members, assigns the right roles, creates divisions and projects, enforces who can do what, and leaves an auditable history of structural changes.

The objective is not to centralize every activity. It is to make local autonomy safe, understandable, and scalable.

### The two governing principles

1. **Give each university as much self-management as possible.**
   A local board should be free to organise its members, divisions, projects, announcements, and internal work as long as it follows BAINSA-wide principles and values.

2. **Keep work in the narrowest space that is useful.**
   A project conversation belongs in the project channel. Division work belongs in the division channel. University matters stay in the university category. Only conversations that genuinely benefit the whole network should move into Global BAINSA.

### What Discord contributes

Discord combines several things that would otherwise be spread across multiple tools:

- Persistent text channels for community and operational work.
- Voice rooms for meetings and collaboration.
- Forum channels for searchable, topic-based knowledge and project records.
- Private channels with precise member and board access.
- Reactions for lightweight voting and feedback.
- Native events for announcements and calendars.
- Roles and permission overwrites that express the association’s organisational structure.
- Slash commands that let the bot carry out repeatable administrative workflows.

### Why the structure must stay economical

Discord has platform limits, including:

- 250 roles.
- 500 channels.
- 1,000 active threads.
- There is also a 1,000-overwrite limit on an individual channel. The bot reserves six project-channel overwrites for system and board access, so a project can have at most 994 direct participants.
- There is no possibility to give only creation or editing permissions to a role, without granting it also deletion permission

These limits reinforce the same design principle: do not create a permanent role or channel when a narrower, temporary, or forum-based structure will do.

---

## 2. Overview of the server

```text
START HERE — visible to every new arrival
├── #welcome — read-only orientation
└── #onboarding — read-only application entry point

GLOBAL BAINSA — visible to approved members
├── #bainsa-general — whole-network conversation
├── voice: bainsa-general-room — whole-network voice room
├── #bainsa-announcements — network-wide official updates and events
├── #bainsa-board — Global Presidents + University Presidents
├── forum: projects-showcase — selected cross-network project stories
├── forum: resources — shared knowledge base
├── forum: people-directory — opt-in, bot-managed member profiles
├── forum: channel-proposals — member-led requests for new shared channels
└── #anonymous-feedback — link to a confidential external form

BAINSA <UNIVERSITY> — visible only to that university
├── #general — local member discussion
├── voice: general-room — local university voice room
├── #announcements — local official updates and events
├── #board — private local-board workspace
├── #bot-log — scoped commands and board-visible activity
├── forum: projects-showcase — bot-managed university project record
├── #onboarding-review — applicant review queue
├── #<color>-<division> — division working channel
└── voice: <color>-<division>-room — division voice room

ARCHIVE / HISTORY — completed project channels
└── <completed projects> — locked project history

LOGS — global operations
├── #admin-log — Global Presidents + bot, read-only for humans
└── #bot-log — Global President command channel and activity
```

The initial v1 plan contains:

- Bocconi: Projects, Analysis, and Culture.
- Sapienza: Projects.
- Polimi: Projects.

New divisions can be created by command. Creating a whole new university is still planned work.

---

## 3. The role model

The easiest way to understand access is to imagine that a member’s identity is assembled from layers.

### Layer 1: member type

Every approved member has exactly one base identity:

- **Researcher** — an active member who can belong to a division and participate in its work.
- **Alumni** — a member of the wider network who does not need a division assignment.

Researcher and Alumni are mutually exclusive.
These two roles are just names, they do not bring any power or access to any channel with them. The permissions to channels and categories is granted with the second to fourth layers.

### Layer 2: university

Examples:

- `Bocconi`
- `Sapienza`
- `Polimi`

The university role opens that university’s general, announcements, and showcase spaces. It is the main local access boundary.

### Layer 3: division

Examples:

- `Bocconi - Projects`
- `Bocconi - Analysis`
- `Sapienza - Projects`

Division roles give Researchers access to the relevant division text and voice rooms. A new university should start with a Projects division, and its President can add more divisions later.

### Layer 4: position and authority

Board authority is represented by university-scoped roles:

- `<University> - Head of <Division>`
- `<University> - Vice President`
- `<University> - President`
- `Global President`

Scoping the role name to the university is important. A Vice President at Bocconi must not accidentally gain Vice President powers at Sapienza.

### Examples

| Person                    | Implemented role stack                                        | Meaning                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bocconi Projects member   | `Researcher`, `Bocconi`, `Bocconi - Projects`                 | Can use the Bocconi member spaces and Projects division rooms.                                                                                       |
| Sapienza Head of Analysis | `Researcher`, `Sapienza`, `Sapienza - Head of Analysis`       | The Head role itself opens the Analysis rooms and grants scoped authority; the bot intentionally avoids adding the redundant ordinary division role. |
| Polimi Vice President     | `Researcher`, `Polimi`, `Polimi - Vice President`             | Can operate across Polimi but has no authority in other universities.                                                                                |
| Global President          | `Global President` plus any ordinary identity roles they hold | Can operate across all university scopes and use the global bot log.                                                                                 |

### Authority hierarchy

```text
Global President
└── cross-university authority
    └── University President
        └── full authority inside one university
            └── University Vice President
                └── broad member and project operations inside one university
                    └── Division Head
                        └── division and project operations inside one division
```

---

## 4. Access layers: who sees what

| Audience                      | What they can see                                                              |
| ----------------------------- | ------------------------------------------------------------------------------ |
| New arrival                   | Only `START HERE`: welcome and onboarding.                                     |
| Approved Researcher or Alumni | Global member channels and their university’s member channels.                 |
| Researcher with a division    | The relevant division text and voice rooms.                                    |
| Project participant           | The private project channel through a direct user permission.                  |
| University board member       | Their university board, bot log, onboarding review, and scoped project access. |
| University President          | The global board channel in addition to local board access.                    |
| Global President              | Cross-university governance, global bot log, and private operational logs.     |

The server therefore has three different kinds of conversation:

1. **Public to all approved BAINSA members** — global general, resources, channel proposals, announcements, and showcases.
2. **Locally private** — university, division, and project work.
3. **Governance-only** — local boards, the global board, onboarding review, bot logs, and administrative logs.

---

## 5. Deep dive: START HERE and onboarding

```text
START HERE — visible to every new arrival
├── #welcome — read-only orientation
└── #onboarding — read-only application entry point
```

### `#welcome`

This is the orientation page. A new arrival learns:

- What BAINSA is.
- How the server is divided into global, university, division, and project spaces.
- Where different kinds of work belong.
- That they need to complete onboarding before the rest of the server becomes visible.

It is read-only so the first experience remains clean and predictable.

### `#onboarding`

The member presses **Begin onboarding** and completes a private four-step flow:

1. Enter a full name.
2. Choose Researcher or Alumni.
3. Choose a university.
4. If Researcher, choose exactly one division. Alumni choose no division.

Every private screen keeps the applicant's choices and ends with a destination-named Continue action, a Back action, and Cancel. The final review can return to the last editable step. When the applicant submits, the controls are replaced by a clear waiting message before the bot posts the request in the chosen university’s `#onboarding-review` channel.

Any authorised board member for that university—a Division Head, Vice President, President, or Global President—can approve or reject it. Approval creates or updates the member record, assigns the correct Discord roles, and sets the member's server nickname from the onboarding name automatically. Rejection requires a reason that is shared with the applicant and gives them a path to reapply.

The bot attempts a direct decision DM, but delivery does not depend on DMs: **Check application status** in `#onboarding` always shows the latest recorded result and rejection reason. Approval first explains the member's new access and useful starting spaces, then asks them to create a profile so other members can find them for research, projects, and collaboration. The applicant cannot request a board position through onboarding.

The benefit is consistency: new members do not need an administrator to manually understand and reproduce the permission model every time.

---

## 6. Deep dive: GLOBAL BAINSA

```
GLOBAL BAINSA — visible to approved members
├── #bainsa-general — whole-network conversation
├── voice: bainsa-general-room — whole-network voice room
├── #bainsa-announcements — network-wide official updates and events
├── #bainsa-board — Global Presidents + University Presidents
├── forum: projects-showcase — selected cross-network project stories
├── forum: resources — shared knowledge base
├── forum: channel-proposals — member-led requests for new shared channels
└── #anonymous-feedback — link to a confidential external form
```

### `#bainsa-general`

This is the conversation space for subjects that genuinely concern the whole network: cross-university questions, introductions, shared opportunities, and discussions that benefit from broader participation.

Local operational work should stay in the relevant university area.

### Voice: `bainsa-general-room`

This is the informal, whole-network meeting room. Approved Researchers, Alumni, and board roles can join; board roles can also create Discord events in the room.

### `#bainsa-announcements`

This is the read-only official feed for network-wide news and events. Global Presidents and University Presidents can publish; ordinary members read.

Announcements and scheduled events use Discord’s native tools in v1. There is no bot announcement command.

### `#bainsa-board`

This is the bridge between the central association and its chapters. Access is limited to:

- Global Presidents.
- The President of each university.

It is the correct place for cross-university decisions, escalations, shared standards, and coordination between chapter leadership. Vice Presidents and Heads remain in their local board spaces unless deliberately included in a narrower working channel or project.

### Forum: `projects-showcase`

This should present a curated selection of work from the university showcases, not every internal project update.

**Current v1:** the university showcase is bot-managed when projects are created and updated. The global showcase exists as a read-only forum, but the selection/promotion policy is not automated.

**Recommended decision:** let each university board nominate its own strongest projects, while the global board enforces only shared presentation and safety standards. A simple policy could be:

- Each university selects up to a fixed number of projects per semester.
- The project must have a clear summary, outcome, contributors, and shareable materials.
- Confidential or unfinished internal work is excluded.
- Global Presidents can request formatting or privacy changes, but do not replace the university’s editorial choice.

This preserves local autonomy while keeping the global showcase useful.

### Forum: `resources`

This is the shared, searchable knowledge base. Suggested resource families include:

- Master’s programmes.
- Research papers and research methods.
- Internships.
- Alumni directory guidance or an approved alumni database link.
- Study material.
- Tools, datasets, and templates.
- Opportunities such as grants, competitions, conferences, and calls for papers.

Posts should use clear titles, appropriate tags, a short explanation of why the resource is useful, and any access or expiry information. Personal data and restricted alumni information should remain in an access-controlled external system rather than being posted openly.

### Forum: `people-directory`

This is a global, opt-in directory for approved Researchers and Alumni to discover each other by
current work, interests, and future goals. It sits beside `resources`, is hidden from applicants and
removed members, and is not required for approval or ordinary server access.

After approval, a member may receive a best-effort DM linking here; `Start here` remains the reliable
entry point. The member presses **Create or update my profile** to open a private, button-driven
wizard—there is no profile slash command. Like project creation, every screen keeps the complete
grouped summary at the top and ends with one primary action, one named Back action, and **Cancel**.
The wizard asks for:

- **Where you are now:** a one-line headline, current role or activity, and optional organisation
  and location.
- **What you want to explore:** research, internship, role, or collaboration goals, followed by
  interests, topics, problems, or industries that matter to the member.
- **Directory tags:** one to four tags that describe their field or environment.

Organisation and location are optional context. Public-to-approved-members email, a LinkedIn profile,
and a research-profile link are optional too. Discord DM is always the default contact path; contact
should be respectful and relevant. A private preview explains that publication makes the profile
visible to every approved BAINSA member, and only **Publish profile** makes it public.

Members cannot write forum posts or replies here. The bot creates and maintains exactly one read-only
thread with one summary message for each published profile. The message uses the same grouped
presentation shown in the wizard’s final review. It applies the member’s BAINSA university as a forum tag from
the membership record. To change the profile, members return to `Start here`;
they do not edit the forum post directly. **Unpublish my profile** asks for confirmation, hides the
saved record for easy republishing, and queues deletion of the Discord post. Removing or departing a
member also hides the profile and queues deletion. Reapproval does not silently republish it.

Use the forum's native text search and tags to browse. It uses Discord's list layout, not a sortable
table. The complete managed tag set is:

| Category | Tags |
| --- | --- |
| BAINSA university — added by the bot | `Bocconi`, `Sapienza`, `PoliMi` |
| Field | `AI & Data`, `Econ & Finance`, `Neuroscience`, `Biology`, `Eng & Robotics`, `Life & Health Sci`, `Social Sciences`, `Math & Physics`, `Humanities & Design` |
| Environment | `Academia`, `Industry`, `Entrepreneurship` |

Each profile has one derived BAINSA university tag plus one to four selected tags. Treat this as stable,
managed governance vocabulary: change categories deliberately. Employers, job titles, laboratories,
technologies, and narrow research topics belong in the searchable free text rather than in new tags.

The bot's reconciliation worker retries pending create, edit, and deletion work if Discord is
temporarily unavailable. It also performs bounded maintenance to return auto-archived profiles and
the guide to the browseable list without sending keep-alive replies. Routine updates edit the
starter message in place instead of adding duplicates.

V1 adds no people-directory slash commands, LinkedIn imports or scraping, any external sortable
table or export, phone and social-contact extras, endorsements, recommendations, direct-message
automation, or staff editing of another member's profile. This describes the intended directory
behavior; it is not a claim that the release quality gate has passed.

### Forum: `channel-proposals`

Any approved member can open a post proposing a new shared channel. A useful channel proposal should state:

- The channel’s purpose and intended audience.
- Why existing channels are insufficient.
- The expected activity or output.
- Whether it is global, university-specific, or temporary.
- Who is willing to lead it.

Members show interest through emoji reactions. Reactions are evidence of demand, not automatic approval.

**Recommended decision:** apply the narrowest-space rule to approval:

- A university-specific proposal is approved and created by that university’s President.
- A genuinely cross-network proposal is reviewed by the global board, meaning Global Presidents and University Presidents.
- Prefer a temporary thread or forum post before creating a permanent channel.
- Review new channels after a defined trial period and archive inactive ones.

**Planned:** add a bot command to approve a proposal and create the resulting space. That command does not exist in v1.

### `#anonymous-feedback`

This channel is read-only and links to an external confidential form, such as Google Forms. The Discord channel explains who receives the feedback and how it will be handled, but anonymous submissions should not be collected publicly in Discord.

---

## 7. Deep dive: each university

```
BAINSA <UNIVERSITY> — visible only to that university
├── #general — local member discussion
├── voice: general-room — local university voice room
├── #announcements — local official updates and events
├── #board — private local-board workspace
├── #bot-log — scoped commands and board-visible activity
├── forum: projects-showcase — bot-managed university project record
├── #onboarding-review — applicant review queue
├── #<color>-<division> — division working channel
└── voice: <color>-<division>-room — division voice room
```

Every university receives the same basic operating structure so members can move between chapters without relearning the server.

### `#general`

The local discussion room for questions, coordination, and updates relevant only to that university.

### Voice: `general-room`

This is the informal meeting room for members of the university. The university role can join, while the university board and Global President roles can also create Discord events in the room.

### `#announcements`

The official local feed. University board members can publish; ordinary university members read. Native Discord events can be used for local calendars.

### Forum: `projects-showcase`

Every project gets a forum post when it is created. The bot updates the post as project details change and adds the final outcome when the project closes.

The forum is the university’s durable, browseable project record. The private project channel remains the working room; the showcase is the discoverable summary.

### `#board`

The private working room for the local board. It is used for member matters, division planning, project supervision, and local escalations.

### `#bot-log`

This has two functions:

1. It is the only university channel where slash commands can be run.
2. It stores concise, board-visible activity messages for successful commands that change shared state.

Ordinary conversation belongs elsewhere. Board members may discuss a project inside its private channel, but v1 commands still have to be run in `#bot-log`.

### `#onboarding-review`

The queue of membership applications for that university. The board checks the applicant’s identity, member path, university connection, and requested division before approving or rejecting the request.

### Division text and voice rooms

Each division can have:

- A colour-coded text room such as `#🟦-projects`.
- A matching voice room such as `🟦-projects-room`.

The Projects division is the standard starting point. Presidents can create further divisions and choose whether each needs text and voice channels.

---

## 8. Projects: the complete lifecycle

### 1. Creation

An authorised Head, Vice President, President, or Global President runs `/project-create` in the correct `#bot-log`. The command opens a polished private wizard instead of collecting arguments in the command line.

The wizard moves through five screens: project name, university and division, members and supervisors, dates and optional notes, then final review. The project name stays at the top throughout. Discord-native multi-user selectors accept up to 25 people in each group. Because onboarding names are synchronized to server nicknames, the native selector can find members by their recorded name or Discord username.

After **Create project**, the controls disappear and a waiting message explains that eligibility, persistence, and Discord channel setup are running. If work fails before the project commits, the complete setup returns with **Try creating project**, **Back to details**, and **Cancel setup**. Once the database commits, the setup stays closed so a failed acknowledgement can never cause a duplicate project.

Members must be active Researchers in the selected division. Supervisors must be active members of the selected university and may be Alumni.

### 2. Database record and Discord channel

The bot commits the project and its participants to PostgreSQL, records an audit entry, and creates a private channel under the owning university category.

The channel is visible only to:

- Assigned project members.
- Assigned supervisors.
- Assigned board liaisons.
- The relevant Division Head.
- The university Vice President and President.
- Global Presidents.
- The bot.

Project access uses direct member overwrites, so the server does not consume one new Discord role for every project.

### 3. Working phase

The project channel is the single workspace for discussion, files, links, decisions, and handover information. The board can add or remove participants, change a participant’s project role, rename the project, update its expected end, or pause and reactivate it.

The university showcase thread is updated with non-private project information.

### 5. Closing

`/project-close` requires an outcome and final notes. The bot:

- Changes the project status to `completed`.
- Records the outcome and private final notes.
- Updates the project channel and showcase thread.
- Prevents ordinary project members from sending new messages while preserving read history.
- Moves the channel to `ARCHIVE / HISTORY`.

There is no separate archive or delete command in v1.

### Current archive weakness

Moving every completed project into one category is simple, but it will eventually become difficult to navigate and consume the server’s channel allowance.

### Cross-university projects

**Current v1:** every project belongs to exactly one university and one division. Cross-university projects are intentionally not implemented.

The main placement choices are:

1. Put the channel in Global BAINSA.
2. Put it in one university, causing invited members from other universities to see one channel inside that university category.
3. Create a separate cross-university projects category.

**Recommended decision:** use a dedicated `CROSS-UNIVERSITY PROJECTS` category with direct participant permissions. Store a lead university and lead division for ownership and escalation, while allowing participants and supervisors from multiple universities.

This is clearer than arbitrary placement, avoids making the global community category an operational workspace, and keeps cross-university work easy to identify. The bot and database model must be extended before this can be used.

---

## 10. How the bot works

The bot is the controlled administrator of the server. Humans ask for a change through a slash command; the bot checks the request against the governance rules; then it updates Discord and the database.

The bot never trusts a command merely because Discord displayed it. It checks:

1. Is the command being used in a valid `#bot-log`?
2. Does the caller currently hold the required board role?
3. Is the target university or division inside the caller’s scope?
4. Is the target member eligible for the requested role or project?
5. Would the change violate another rule, such as removing a division member who still has an active project there?

Only after those checks does the bot act.

### Command visibility by tier

| Role                      | Command visibility                                         |
| ------------------------- | ---------------------------------------------------------- |
| Global President          | All commands.                                              |
| University President      | President, executive, board, and project commands.         |
| University Vice President | Executive, board, and project commands.                    |
| Division Head             | Board/project commands, restricted to the Head’s division. |
| Researcher or Alumni      | No administrative commands.                                |

Visibility in Discord is only the first layer. Execution-time checks remain authoritative.

### Private and persistent responses

Discord calls the private response **ephemeral**. It is visible only to the person who ran the command and does not become normal channel history.

- `/guide`, information lookups, validation errors, failures, and private-note-only changes remain ephemeral.
- A successful command that changes shared state posts one concise activity entry in the current `#bot-log`.
- Internal member notes, removal reasons, and project final notes are excluded from the public activity entry.
- The complete technical record is stored in PostgreSQL’s audit log.

This gives the person immediate feedback without flooding the channel, while still giving the board a useful operating history.

### Codebase in brief

The bot is written in TypeScript, compiled to native Node.js 22 ESM JavaScript, and uses:

- `discord.js` for Discord commands, roles, channels, components, and permissions.
- PostgreSQL for members, universities, divisions, projects, onboarding, reconciliation, and audit history.
- ES modules throughout the codebase.

The main code areas are:

| Area                      | Responsibility                                                                   |
| ------------------------- | -------------------------------------------------------------------------------- |
| `src/commands`            | Defines slash-command inputs and connects commands to services.                  |
| `src/services/governance` | Member, division, and board workflows.                                           |
| `src/services/projects`   | Project rules, persistence, Discord access, and reconciliation.                  |
| `src/onboarding`          | Applicant flow and board review controls.                                        |
| `src/guide`               | Role-aware interactive `/guide`.                                                 |
| `src/runtime`             | Command dispatch, command-channel checks, visibility, and autocomplete security. |
| `src/provision`           | Idempotently creates and repairs the server structure.                           |
| `db/migrations`           | Evolves the PostgreSQL schema safely.                                            |
| `test`                    | Unit, contract, permission, reconciliation, and integration tests.               |

---

## 11. Command guide

All slash commands must be run in a valid `#bot-log`. Inputs marked “optional” may be omitted. For every mutating command below, the detailed technical result is recorded in the audit log; “Activity” describes what appears in Discord channel history.

### `/guide`

- **Why it exists:** board members should not have to memorise the command system.
- **Who can use it:** any board member in their university bot log; Global Presidents in the global bot log.
- **Inputs:** none.
- **Returns:** a private, interactive guide filtered to the caller’s current roles and scope.
- **Activity:** none. Navigation rechecks roles, so an already-open guide cannot preserve old access.

### Member commands

New members enter through onboarding. A board approval creates the member record, assigns the managed roles, records the decision, and sets the verified full-name nickname.

#### `/member-update`

- **Why:** change a member’s type, university, divisions, or notes while keeping Discord and PostgreSQL consistent.
- **Who:** Global Presidents; University Presidents and Vice Presidents inside their university.
- **Inputs:** `user`; optional replacement `member_type`, `university`, `divisions`, and `notes`.
- **Returns:** private confirmation of the saved update.
- **Rules:** only a Global President can move someone between universities. Changing a Researcher to Alumni clears incompatible division assignments.
- **Activity:** visible shared changes are posted. A notes-only update remains private.

#### `/member-remove`

- **Why:** remove a member and clean all managed access in one controlled workflow.
- **Who:** Global Presidents; University Presidents and Vice Presidents inside their university.
- **Inputs:** `user`; optional private `reason`.
- **Returns:** private confirmation after the member is immediately kicked and records/access are deactivated.
- **Rules:** a Vice President cannot remove their President. Protected Global Presidents and the Bot cannot be removed by university officers.
- **Activity:** the removal is posted without the private reason.

#### `/member-info`

- **Why:** inspect the system’s current understanding of a member.
- **Who:** Global Presidents and university board members, within scope.
- **Inputs:** optional `user`; where supported, omission means the caller.
- **Returns:** private full name, member type, university, divisions, board roles, and active project assignments.
- **Activity:** none.

### Division commands

#### `/division-create`

- **Why:** let universities extend their structure without manual role and channel setup.
- **Who:** Global Presidents and the selected university’s President.
- **Inputs:** `university`, `division_name`, `color`, initial `head`, `create_text_channel`, and `create_voice_channel`.
- **Returns:** private confirmation after the division, access role, Head role, selected channels, and board assignment are created.
- **Rules:** the initial Head receives Researcher, university, and scoped Head roles. The Head role itself grants division access.
- **Activity:** the new division, Head, colour, and created resources are posted.

#### `/division-update`

- **Why:** update a division name or colour consistently across the database, roles, and channels.
- **Who:** Global Presidents and the selected university’s President.
- **Inputs:** `university`, `current_name`, optional `new_name`, optional `color`.
- **Returns:** private confirmation after all managed names and colours are reconciled.
- **Activity:** changed names and colours are posted.

#### `/division-add-member`

- **Why:** place a Researcher into a division and grant the correct rooms.
- **Who:** Global Presidents; the university President or Vice President; the selected Division Head.
- **Inputs:** `user`, `university`, `division`.
- **Returns:** private confirmation after the relationship and access role are added.
- **Rules:** the target must be eligible as an active Researcher.
- **Activity:** member and division are posted.

#### `/division-remove-member`

- **Why:** remove division access without removing the person from BAINSA.
- **Who:** Global Presidents; the university President or Vice President; the selected Division Head.
- **Inputs:** `user`, `university`, `division`; optional private `reason`.
- **Returns:** private confirmation after the division relationship and access role are removed.
- **Rules:** removal is blocked while the person still has active project access in that division.
- **Activity:** the division removal is posted without the reason.

### Board commands

#### `/board-assign`

- **Why:** appoint board members through the same auditable role hierarchy used for every other operation.
- **Who:** Global Presidents for any university; a University President or Vice President inside their university.
- **Inputs:** `user`, `university`, `role` (`Head`, `Vice President`, or `President`); `division` is required only for Head.
- **Returns:** private confirmation after the member, board assignment, and roles are reconciled.
- **Rules:** a University President or Global President can appoint a University President. Multiple co-Presidents can be active in one university; Vice Presidents cannot appoint a President.
- **Activity:** appointee, university, position, and division where relevant are posted.

#### `/board-remove`

- **Why:** remove authority while preserving the person’s ordinary membership.
- **Who:** Global Presidents for any university; a University President or Vice President inside their university.
- **Inputs:** `user`, `university`, `role`; optional `division` for a specific Head role and optional private `reason`.
- **Returns:** private confirmation after the board assignment and managed board role are removed.
- **Rules:** a University President or Global President can remove a University President. Vice Presidents cannot remove a President. Leaving Head division blank removes all Head roles in that university.
- **Activity:** the removed position is posted without the reason.

#### `/board-info`

- **Why:** view the active board and detect missing or inconsistent Discord roles.
- **Who:** Global Presidents and active board members of the selected university.
- **Inputs:** `university`.
- **Returns:** a private board roster and any synchronisation warnings.
- **Activity:** none.

### Project commands

#### `/project-create`

- **Why:** create a governed project record, private workspace, team, and showcase entry in one workflow.
- **Who:** Global Presidents; the selected university’s President or Vice President; the selected Division Head.
- **Inputs:** No command-line fields. A private five-step wizard collects the name, university and division, initial members and supervisors, dates, and optional notes before final confirmation.
- **Returns:** private confirmation that the project was created, or that its committed Discord state is pending automatic reconciliation.
- **Rules:** members must be active Researchers in the division; supervisors must be active university members; dates use `YYYY-MM-DD`; one person cannot appear in both lists; maximum 994 participants.
- **Activity:** project, team, timeline, and Discord state are posted; notes are omitted.

#### `/project-add-member`

- **Why:** add a participant or change their project function without manual permission editing.
- **Who:** Global Presidents; the project university’s President or Vice President; the project Division Head.
- **Inputs:** `project`, `user`, `role` (`member`, `supervisor`, or `board_liaison`).
- **Returns:** private confirmation after the participant record and channel overwrite are reconciled.
- **Rules:** the person must meet the eligibility rule for the chosen role. Only active or paused projects can change.
- **Activity:** person, project, and new project role are posted.

#### `/project-remove-member`

- **Why:** remove both the participant record and private channel access together.
- **Who:** Global Presidents; the project university’s President or Vice President; the project Division Head.
- **Inputs:** `project`, `user`; optional private `reason`.
- **Returns:** private confirmation after access is reconciled.
- **Rules:** only active or paused projects can change.
- **Activity:** removal is posted without the reason.

#### `/project-update`

- **Why:** maintain the project’s identity, schedule, status, and notes.
- **Who:** Global Presidents; the project university’s President or Vice President; the project Division Head.
- **Inputs:** `project`; optional `name`, `expected_end`, `notes`, and `status` (`active` or `paused`).
- **Returns:** private confirmation after the project, channel, and showcase are updated.
- **Rules:** expected end cannot precede the start. Completed projects require `/project-close`.
- **Activity:** visible changes are posted. A notes-only update remains private.

#### `/project-close`

- **Why:** complete the project with a durable outcome and preserve its working history.
- **Who:** Global Presidents; the project university’s President or Vice President; the project Division Head.
- **Inputs:** `project`, `outcome`, private `final_notes`.
- **Returns:** private confirmation after the project becomes completed, is locked, and moves to history.
- **Activity:** the outcome and archive state are posted; final notes are omitted.

#### `/project-info`

- **Why:** privately inspect a project’s current canonical record.
- **Who:** Global Presidents; scoped President, Vice President, or Head; project participants who can view that project.
- **Inputs:** `project`, selected from projects visible to the caller.
- **Returns:** private name, scope, status, timeline, channel, notes, and participant lists.
- **Activity:** none.

---

### Proposed `/university-create`

**Planned recommendation:** only a Global President should be able to create a university.

Suggested inputs:

- `name`
- `short_name` or slug
- `color`
- Initial `president`
- Initial division name, defaulting to `Projects`
- Initial Division Head
- Whether to create the initial text and voice rooms

Suggested result:

- Create the university database record.
- Create university, President, Vice President, division, and Head roles.
- Create the standard university category and channels.
- Assign the initial President and Head.
- Seed orientation messages.
- Synchronise command visibility.
- Post a global bot-log activity entry and write a complete audit record.

This should be implemented as an idempotent, transaction-aware workflow with compensation or reconciliation for partial Discord failures. Until then, a new university must be added through the server plan and provisioning process.
