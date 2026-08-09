# Plan 001: Add the opt-in BAINSA people directory

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md` unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b98a5bb..HEAD -- db/migrations src/profiles src/runtime/dispatcher.ts src/bot.ts src/onboarding/service.ts src/services/governance/service.ts src/provision src/content/seeds.ts scripts/reset-database.ts test README.md docs`
> If an in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding. On a material mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day feature including migration, Discord failure recovery, and tests)
- **Risk**: MED (public-within-BAINSA personal data plus PostgreSQL/Discord consistency)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `b98a5bb`, 2026-08-08

## Why this matters

Issue #12 asks for a small, trusted “LinkedIn for BAINSA”: approved Researchers and Alumni should be able to discover people by research interests, current work, and future goals without learning several slash commands. The selected product is an opt-in, global Discord forum containing one consistent bot-managed post per published member profile. Members create, update, and unpublish their own profile through buttons, select menus, and private modals; PostgreSQL is authoritative and a durable reconciliation worker keeps Discord in sync.

This plan deliberately separates membership approval from profile publication. Approval grants ordinary server access immediately. Publishing professional information is optional, contact fields are optional, and unpublishing must durably remove the forum post even if Discord is temporarily unavailable.

## Product contract

### User journey

1. A board member approves the existing membership application exactly as today; profile completion never blocks the role assignment or ordinary server access.
2. After approval, the bot makes a best-effort DM containing a link to the global `people-directory` forum. If DMs are disabled, the same entry point remains available in the forum’s `Start here` post.
3. An approved member presses **Create or update my profile**. The bot verifies `members.status = 'active'` server-side and starts a private wizard. No slash command is added.
4. The wizard asks the member to complete the required profile fields, choose one to four curated tags, and optionally add professional contact links.
5. A private preview states that publishing makes the content visible to every approved BAINSA member. Only **Publish profile** mutates the public profile row.
6. The bot creates or updates exactly one read-only forum thread with one profile summary message. The member’s type, BAINSA university, and Researcher division are derived from canonical membership tables and cannot be edited in the profile wizard.
7. The member returns to `Start here` to update or unpublish. **Unpublish my profile** requires confirmation, preserves the structured record as hidden for easy republishing, and durably queues deletion of the Discord thread.
8. Removing or departing a member hides their profile and queues deletion. Reapproval does not silently republish it; the returning member must preview and publish again.

### Required member-authored fields

Use these exact concepts and prompts. UI labels may be shortened only to meet Discord component limits.

| Stored field    | Prompt                                                                                                             | Validation                                      | Why it exists                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| `headline`      | “In one line, how should BAINSA members understand what you do?”                                                   | trimmed, collapsed whitespace, 10–80 characters | Scannable forum title/summary                                      |
| `about`         | “Tell us a little about yourself beyond your title. Which topics, problems, or industries genuinely interest you?” | trimmed, 20–300 characters                      | Human context that a CV does not provide                           |
| `current_role`  | “What are you doing now? Examples: MSc student, research assistant, ML engineer.”                                  | trimmed, 2–80 characters                        | Searchable present role; “Exploring my next role” is valid         |
| `goals`         | “What would you like to explore or do next?”                                                                       | trimmed, 10–250 characters                      | Research, internship, role, and collaboration intent               |
| `selected_tags` | “Choose up to four tags that best describe your field, environment, or availability.”                              | 1–4 unique active taxonomy keys                 | Native forum filtering; the member-type tag is added automatically |

### Optional member-authored fields

| Stored field           | Prompt/meaning                                               | Validation                                                                                                                     |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `current_organization` | University, laboratory, company, nonprofit, or “Independent” | blank or 2–100 trimmed characters                                                                                              |
| `location`             | City/country or remote/time-zone context                     | blank or 2–60 trimmed characters                                                                                               |
| `email`                | Public-to-approved-members contact email                     | blank or at most 254 characters; normalize case/whitespace and apply a practical email-shape check, not an RFC-complete parser |
| `linkedin_url`         | LinkedIn profile                                             | blank or HTTPS URL up to 500 characters whose hostname is `linkedin.com` or a subdomain                                        |
| `research_profile_url` | Google Scholar, ORCID, lab page, or another research profile | blank or HTTP(S) URL up to 500 characters                                                                                      |

All contact values are optional. Do not add phone, X, Instagram, mandatory email, or a hidden staff-only contact field. Discord mention/DM is always rendered as the default contact path. Do not fetch remote profile data or link previews in application code.

### Forum tag taxonomy

Discord permits at most 20 available tags per forum and at most five applied tags per post. Provision exactly the following 15 managed tags, leaving five slots for future taxonomy changes. Store stable lowercase keys in PostgreSQL; map them to labels at the Discord boundary.

| Category    | Key                 | Discord label         | Application rule                                                   |
| ----------- | ------------------- | --------------------- | ------------------------------------------------------------------ |
| University  | `bocconi`           | `Bocconi`             | Derived automatically from `universities.name`; never selectable   |
| University  | `sapienza`          | `Sapienza`            | Derived automatically from `universities.name`; never selectable   |
| University  | `polimi`            | `PoliMi`              | Derived automatically from `universities.name`; never selectable   |
| Field       | `ai_data`           | `AI & Data`           | Selectable                                                         |
| Field       | `econ_finance`      | `Econ & Finance`      | Selectable                                                         |
| Field       | `neuroscience`      | `Neuroscience`        | Selectable                                                         |
| Field       | `biology`           | `Biology`             | Selectable                                                         |
| Field       | `eng_robotics`      | `Eng & Robotics`      | Selectable                                                         |
| Field       | `life_health`       | `Life & Health Sci`   | Selectable                                                         |
| Field       | `social_sciences`   | `Social Sciences`     | Selectable                                                         |
| Field       | `math_physics`      | `Math & Physics`      | Selectable                                                         |
| Field       | `humanities_design` | `Humanities & Design` | Selectable                                                         |
| Environment | `academia`          | `Academia`            | Selectable                                                         |
| Environment | `industry`          | `Industry`            | Selectable                                                         |
| Environment | `entrepreneurship`  | `Entrepreneurship`    | Selectable                                                         |

At publication, apply exactly one derived BAINSA university tag plus the member’s one to four selected tags. Validate that all labels are unique and at most 20 characters, that the taxonomy has at most 20 entries, and that no published post receives more than five tags. Job titles, employers, specific laboratories, technologies, and narrow research topics remain searchable profile text rather than an ever-growing tag list.

### Forum presentation

- Provision `people-directory` beside `resources` under `GLOBAL BAINSA`; do not reuse the resources forum.
- Only approved membership roles may view it. Humans may not create posts, send replies, edit bot messages, or create threads. The bot may manage messages and threads.
- Configure Discord’s list layout and the maximum supported auto-archive duration (10,080 minutes).
- The thread name is derived as `Nickname — Headline` and truncated safely to Discord’s 100-character limit. Do not include a Discord ID in the title.
- Put all profile text in one Components V2 starter card using the same grouped summary shown in the wizard’s final review. Keep its text display below 4,000 characters.
- The starter contains the authored profile fields, selected tag labels, and the owner mention used for Discord contact and recovery.
- Set `allowedMentions: { parse: [] }` for create and edit operations so profile publication never pings the owner, roles, or `@everyone`.
- Escape member-authored Markdown where it could imitate headings or alter the fixed structure. Validate URLs before rendering links.
- Add no unmanaged comments/replies for routine synchronization and no “keep alive” messages.

### Privacy and authorization rules

- The forum is hidden from `@everyone`, pending applicants, removed members, and users without an approved identity role.
- Every profile component handler must re-check the active `members` row; visibility of the button is not authorization.
- A profile session is keyed to the initiating Discord user and guild. Another member cannot view or mutate it by replaying a custom ID.
- Only the profile owner may publish, update, or unpublish their row. Board roles gain no edit override in this issue.
- Never include biography, goals, email, or URLs in application logs, audit log JSON, board activity messages, or thrown error messages. Audit only action metadata such as prior/next visibility and selected tag keys.
- An incomplete/cancelled wizard is private and never writes partial public content. Use the existing in-memory session pattern; a bot restart may expire the wizard and require the user to start again.

## Current state

- `src/onboarding/components.ts:22-34` exposes a persistent **Begin onboarding** button, and `src/onboarding/service.ts:237-292` approves membership inside a transaction before acknowledging only the reviewer. This is the hook for a non-blocking post-approval profile prompt.
- `src/onboarding/repository.ts:238-273` upserts canonical active membership and division data. Profile posts must derive membership facts from these tables rather than copying editable values into the wizard.
- `src/provision/plan.ts:26-35` defines the global channel contract; it currently has `projects-showcase`, `resources`, and `channel-proposals`, but no people directory.
- `src/provision/plan.ts:325-332` returns one generic global tag set. The people directory needs a separate managed taxonomy; do not change resource/showcase meanings.
- `src/provision/permissions.ts:146-154` gives approved members full forum posting access through `memberForumOverwrites`. The directory instead needs read-only human access like `showcaseForumOverwrites` at lines 157-162.
- `src/provision/discord.ts:429-469` provisions the global forums and their `Start here` guide threads. Add the directory here.
- `src/provision/discord.ts:641-688` can reconcile a forum’s name, parent, tags, and permissions. Extend its optional forum settings for list layout, 10,080-minute auto-archive, and an exact/managed tag mode used only by the directory.
- `src/provision/discord.ts:760-774` creates a forum guide without forwarding `options.components` on the create path. Fix that path so the new directory entry buttons exist on both first provision and later updates; add regression coverage.
- `src/runtime/dispatcher.ts:8-23` accepts named component handlers, while lines 77-118 route onboarding, project setup, and guide components. Add a dedicated profile handler following this pattern; do not route profile buttons through slash-command authorization.
- `src/services/projects/setup.ts:93-187` is the established in-memory, actor-bound, expiring wizard pattern. Match its session ownership, TTL cleanup, prefilled editing, busy flag, private components, and expiry errors instead of persisting half-completed profiles.
- `db/migrations/007_project_reconciliation.sql` plus `src/services/projects/reconciliation.ts` are the durable desired-state/generation pattern for retrying PostgreSQL-to-Discord synchronization. Reuse the pattern in an isolated profile domain; do not couple profiles to project rows.
- `src/services/governance/service.ts:483-564` is the canonical member-removal transaction. It must hide and enqueue the directory profile without logging profile content.
- `src/bot.ts:16-29` wires interaction services and graceful worker shutdown; lines 31-52 start the existing project reconciliation worker.
- `scripts/reset-database.ts:16-35` explicitly enumerates application tables and helper functions. New profile tables must be included in dependency-safe order.
- `CONTRIBUTING.md` requires Node 22/npm 10.9.2, `.js` ESM import suffixes, narrow interfaces at service boundaries, repositories without Discord objects, and gateways without database clients. Preserve those boundaries.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 using the lockfile |
| Typecheck | `npm run check` | exit 0, no TypeScript errors |
| Build | `npm run build` | exit 0 and generated test/runtime JavaScript under ignored `dist/` |
| Unit suite | `npm test` | all tests pass without real Discord/PostgreSQL credentials |
| Integration suite | `TEST_DATABASE_URL=postgres://localhost/bainsa_discord_test npm run test:integration` | all integration tests pass against a disposable local test database |
| Lint | `npm run lint` | exit 0 |
| Format | `npm run format:check` | exit 0 |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | exit 0 with no high/critical production advisories |
| Diff safety | `git diff --check` | no whitespace errors |

## Suggested executor toolkit

- Use the repository’s installed `find-docs`/Context7 workflow, if available, before relying on Discord API details. Resolve the exact `discord.js` version from `package.json` first. Verify `GuildForumThreadManager.create`, starter-message editing, applied-tag editing, list-layout options, auto-archive/unarchive, modal/component limits, and thread deletion against current official documentation.
- Use `src/services/projects/setup.ts` and `src/services/projects/reconciliation.ts` as local implementation exemplars. Copy their boundaries and state-transition ideas, not unrelated project terminology.

## Scope

**In scope** (the only production/documentation paths to modify):

- `db/migrations/013_member_profiles.sql` (create)
- `src/profiles/` (create focused `custom-ids.ts`, `state.ts`, `formatters.ts`, `repository.ts`, `gateway.ts`, `components.ts`, `service.ts`, `reconciliation.ts`, and `index.ts` as needed)
- `src/runtime/dispatcher.ts`
- `src/bot.ts`
- `src/onboarding/service.ts`
- `src/services/governance/service.ts`
- `src/provision/plan.ts`
- `src/provision/permissions.ts`
- `src/provision/discord.ts`
- `src/content/seeds.ts`
- `scripts/reset-database.ts`
- `README.md`
- `docs/bainsa-discord-presentation-guide.md`

**In scope for tests**:

- New `test/profile-*.test.ts` unit files
- New `test/integration/profile-lifecycle.test.ts`
- `test/migration-contract.test.ts`
- `test/integration/migrations.test.ts`
- `test/provision-plan.test.ts`
- `test/runtime-dispatcher.test.ts`
- `test/integration/service-transactions.test.ts`
- `test/service-boundaries.test.ts` if needed to characterize the new domain boundary

**Out of scope** (do not touch even if tempting):

- `src/commands/**`, command registration, autocomplete, or a `/profile`/`/people-search` command
- LinkedIn API access, scraping, scheduled imports, remote metadata fetching, or OAuth scopes beyond the existing Discord bot
- A website, spreadsheet export, table UI, or Discord Activity
- Mandatory profile completion, mandatory email, phone numbers, X, Instagram, profile photos, endorsements, recommendations, direct messaging automation, or contact tracking
- Staff editing of another member’s profile
- Broad refactors of onboarding, provisioning, governance, project reconciliation, dispatcher architecture, or migration history
- Editing, renaming, or reordering migrations `003` through `012`
- Adding new runtime dependencies unless official Discord.js capability is genuinely insufficient; STOP first if a dependency appears necessary

## Git workflow

- Work on the existing `issue-12-users-bio` branch unless the operator directs otherwise.
- Commit logical units with the repository’s observed style, for example `feat(#12): add member profile directory schema` and `test(#12): cover profile reconciliation`.
- Do not push, open a PR, close issue #12, or mutate the live Discord/PostgreSQL environment unless the operator explicitly instructs it.

## Steps

### Step 1: Add the profile persistence and reconciliation contract

Create append-only migration `db/migrations/013_member_profiles.sql` with:

1. `member_profiles`, keyed by `discord_user_id text REFERENCES members(discord_user_id) ON DELETE CASCADE`, containing all required and optional fields from the Product contract, `selected_tags text[] NOT NULL`, `visibility text NOT NULL CHECK (visibility IN ('published', 'hidden'))`, nullable unique `forum_thread_id`, nullable `forum_message_id`, `published_at`, nullable `forum_refreshed_at`, `created_at`, and `updated_at`.
2. Database checks for required trimmed lengths, optional maximum lengths, and `cardinality(selected_tags) BETWEEN 1 AND 4`. Application validation remains responsible for taxonomy membership, URL hosts, email shape, and duplicate tag keys.
3. `member_profile_reconciliation`, keyed by and cascading from `member_profiles.discord_user_id`, with `desired_generation >= 0`, status `pending|processing|succeeded|failed`, nonnegative attempts, request/start/success/failure timestamps, and `last_error`, matching the generation-guarded project pattern.
4. Indexes for reconciliation candidates and published profiles due for browseability refresh.
5. `set_updated_at()` triggers for the new mutable tables where applicable.

Update the append-only filename expectation and schema assertions in `test/migration-contract.test.ts`, fresh/idempotent migration counts and table checks in `test/integration/migrations.test.ts`, and the known-table list in `scripts/reset-database.ts`. Add database tests proving incomplete data cannot be published, selected tags require 1–4 values, thread IDs are unique, reconciliation status/generation constraints hold, and a profile cannot reference a nonexistent member.

Do not add drafts to PostgreSQL. The existing wizard convention keeps unsubmitted state in memory; only the final publish transaction writes profile fields.

**Verify**: `npm run check && npm test` → exit 0 and all relevant tests pass.

### Step 2: Implement deterministic taxonomy, normalization, validation, and formatting

Under `src/profiles/`, create pure modules before any Discord/database orchestration:

- Define the exact 15-entry taxonomy above as frozen data with stable keys, labels, category, descriptions, and a `selectable`/derived distinction.
- Export pure guards/mappers that reject unknown, duplicate, derived, or more than four selected keys; combine them with exactly one canonical university tag; assert the resulting applied set has at most five entries.
- Normalize all text consistently. Treat blank optional values as `null`; never turn a missing organization into literal “undefined” or “None”.
- Parse URLs with the platform `URL` class. Allow only HTTP(S), require HTTPS for LinkedIn, enforce its host constraint without substring matching, remove surrounding whitespace, and reject credentials in URLs.
- Add a pragmatic email validator and normalized value; do not send verification mail.
- Implement `canPublishProfile`/`assertPublishableProfile` as the single source of required-field and length rules used by UI and service layers.
- Implement one shared summary formatter for the wizard review and forum starter, returning the thread name, card text, applied tag keys/labels, and safe allowed-mentions configuration. Keep the text display at most 4,000 characters for the maximum legal field values. Escape Markdown in authored values and include a natural owner marker via the Discord mention so recovery can identify orphaned bot-created threads.

Write exhaustive pure tests for boundaries, whitespace normalization, invalid schemes/hosts, false-positive hostnames, unknown/duplicate tags, university derivation, five-tag maximum, Markdown/mention safety, absent optional fields, title truncation, and maximum-length post formatting.

**Verify**: `npm run check && npm test` → exit 0; all boundary cases pass.

### Step 3: Build the private button/modal profile wizard

Model the interaction service after `src/services/projects/setup.ts`, with an isolated `src/profiles` namespace and no commands:

1. Custom IDs must remain under Discord’s 100-character limit and separate the persistent start/unpublish actions from UUID-bound session actions.
2. `start(interaction)` queries the canonical active member and any existing profile, creates one actor/guild-bound session, prefills it on edit/republish, and opens the first modal. Reject non-guild use and inactive/missing members.
3. Use a 30-minute sliding TTL, one active session per member/guild, a busy guard around publish, and deterministic expiry cleanup. Cancellation destroys only the in-memory session and cannot change the published profile.
4. Split the questions across private screens so each modal stays within Discord’s current component limit and mirror project creation’s complete top summary plus primary/Back/Cancel navigation:
   - Where-you-are-now screen: headline, current role, optional organization, and optional location.
   - What-you-want-to-explore screen: goals first, followed by about/interests/passions.
   - Tag screen: one string-select containing only the 12 selectable tags, `minValues=1`, `maxValues=4`.
   - Contact screen: optional email, LinkedIn, and research-profile URL.
   - Review screen: complete private preview, explicit visibility notice, Publish, Back to contact, and Cancel.
5. The persistent guide provides **Create or update my profile** and **Unpublish my profile**. Unpublish opens a private confirmation and is idempotent when nothing is published.
6. On publish, validate again server-side, start a database transaction, lock the member/profile rows, re-check active membership, upsert the public profile as `published`, increment/insert reconciliation desired state, and write a privacy-safe audit record. Commit before attempting Discord reconciliation.
7. Return a private success message containing the forum-post link when synchronization succeeds, or a clear “saved; Discord synchronization will retry automatically” message when pending.

Expose a narrow component-handler interface (`canHandle`, button, string-select, modal submit) through `src/profiles/index.ts`. Add it as a dedicated optional `profiles` handler in `src/runtime/dispatcher.ts`, route it before the generic unavailable-interaction branch, and wire it in `src/bot.ts`. Do not apply board command-channel authorization to profile interactions.

Write component and service tests covering every screen/back path, prefill, ownership replay, inactive member, TTL expiry, double publish, cancel, optional links, invalid submission, database rollback, privacy-safe audit shape, successful publish, pending reconciliation, unpublish confirmation, and unpublish of an already-hidden/missing profile. Extend dispatcher tests for all profile interaction types and unknown/stale IDs.

**Verify**: `npm run check && npm test` → exit 0; new interaction tests pass and the existing command suite is unchanged.

### Step 4: Add durable forum-post reconciliation and browseability maintenance

Implement repository, gateway, and reconciliation modules with the existing boundary rule: repositories accept database clients and plain values only; gateways accept Discord objects/plain desired state and never a database client; the reconciliation service coordinates them.

The reconciler must:

1. Lock one `member_profile_reconciliation` row for the complete attempt and generation-guard completion, matching the project reconciliation concurrency rule.
2. Load canonical `members`, `universities`, and active `member_divisions` data for formatting. Never trust member type/university/division supplied by the wizard.
3. For a published active member, resolve the provisioned global directory forum, map desired tag labels to the forum’s current tag IDs, and create or update exactly one bot-owned thread. Fetch and edit the starter message and remove any legacy managed follow-ups.
4. Set new threads to the 10,080-minute auto-archive duration. Before editing an archived thread, unarchive it through the channel update API without sending a message.
5. If a stored thread/message was manually deleted, clear the stale IDs and recreate it. Before creating when IDs are absent, make a recovery-only scan of active and archived bot-authored profile posts for the natural owner mention and adopt the oldest matching post; delete confirmed duplicates. This closes the “Discord create succeeded, DB ID persistence failed” gap without exposing internal IDs in thread titles.
6. For hidden, removed, or departed members, delete every confidently matched profile thread and clear stored Discord IDs. A missing thread counts as successful deletion.
7. Persist IDs and `forum_refreshed_at` only if the generation being completed is still current. Record failure metadata and log only member ID, generation, and sanitized Discord error—not profile content.
8. Retry pending, failed, and stale-processing rows on startup and every minute, with a bounded batch limit as in project reconciliation.
9. Keep the directory browseable without noisy messages. At a bounded rate, revisit published profiles whose `forum_refreshed_at` is at least one day old; if Discord has auto-archived the thread, unarchive it. Also keep the tracked `Start here` guide thread unarchived. Do not send keep-alive replies. Treat active-thread/rate-limit failures as retryable and expose them in logs.
10. Return a worker with `stop()` that clears timers and waits for an active attempt. Register it in `src/bot.ts` and include it in graceful shutdown beside the project worker.

Write gateway fakes and reconciliation tests for create, update-in-place, tag updates, archived-thread recovery, manual deletion/recreation, orphan adoption, duplicate cleanup, unpublish/delete, member removal, Discord failure/retry, stale generation, concurrent attempts, bounded maintenance, guide unarchive, and worker shutdown.

**Verify**: `npm run check && npm test` → exit 0; no update path appends a message.

### Step 5: Provision the private managed directory forum and guide

Update the provisioning contract:

1. Add `GLOBAL_CHANNELS.PEOPLE_DIRECTORY = 'people-directory'`.
2. Add a dedicated `peopleDirectoryForumTags()` from the exact taxonomy; do not reuse `globalForumTags()`.
3. Add a directory overwrite builder that grants approved Researcher/Alumni identities plus the existing president/global viewer roles read/history access, explicitly denies human post/thread creation and replies, and gives the bot its existing forum management permissions.
4. Extend forum provisioning options narrowly so this directory can use list layout, 10,080-minute auto-archive, and exact managed tags. Preserve merge semantics for existing resources, proposals, and showcase forums.
5. Provision the directory next to `resources` under `GLOBAL BAINSA` and seed a `Start here` guide that explains search, opt-in visibility, optional contacts, tag meanings, editing/unpublishing, and that members should contact each other respectfully through Discord.
6. Attach the persistent Create/update and Unpublish buttons on both first creation and later seed reconciliation. Fix `seedForumGuide` so `options.components` are forwarded when it creates the thread, not only when it updates an existing one.
7. Ensure provisioning can recover the tracked guide even after auto-archive rather than creating duplicate `Start here` threads. Prefer the existing `provisioned_messages` identity before scanning active/archived threads.

Add provisioning tests for channel placement/type, exact 15 managed tags and five-slot reserve, label uniqueness/length, list layout, auto-archive, approved-only read access, denied human posting, bot posting, guide buttons on first provision and update, archived guide adoption, and unchanged semantics for all existing forums.

**Verify**: `npm run check && npm test` → exit 0; existing resource/showcase tag tests still pass.

### Step 6: Connect approval, member changes, departure, and removal

Add lifecycle hooks without making profile availability part of membership correctness:

- After `approveRequest` has committed and the review message is updated, best-effort fetch/DM the approved member with a link to `people-directory` and a short explanation that the profile is optional. DM failure logs only identifiers and never changes the approval result. Inject this notifier into onboarding so onboarding tests do not need real Discord/profile infrastructure.
- When governance changes an active member’s type, university, or division, request profile reconciliation in the same database transaction if a published profile exists. The next post must derive the new BAINSA university tag and details.
- Inside canonical `removeMember`, hide any profile and increment its desired reconciliation generation in the same transaction as the member status change. Include only visibility/sync metadata in the audit record.
- Add a `GuildMemberRemove` listener that idempotently hides/queues a profile for voluntary departures and kick events; it must not change the existing membership record or duplicate the governance removal audit.
- Reapproval leaves hidden profiles hidden. The member can reopen the prefilled wizard and explicitly republish.

Add integration tests showing: approval succeeds when DM fails; new approval does not create an empty forum post; member type/university/division updates enqueue a published profile; removal transaction hides/enqueues it; rollback leaves both member/profile states unchanged; and repeated departure/removal events are safe.

**Verify**: `npm run check && npm test && TEST_DATABASE_URL=postgres://localhost/bainsa_discord_test npm run test:integration` → all unit and integration tests pass.

### Step 7: Document behavior and operational boundaries

Update `README.md` and `docs/bainsa-discord-presentation-guide.md` to describe:

- `people-directory` in the global server tree beside `resources`;
- approved-only, opt-in visibility for Researchers and Alumni;
- the exact member flow and fields at a user-facing level;
- optional email/links and Discord DM as default contact;
- bot ownership of posts and button-based member editing;
- native forum text/tag search and list layout, not a true sortable table;
- retry/unpublish/removal behavior and the maintenance worker;
- the 15-tag taxonomy and governance rule: change stable categories deliberately, keep employers/job titles/narrow topics in free text;
- explicit v1 exclusions: no slash commands, LinkedIn import/scraping, external table, phone, or endorsements.

Do not describe implementation as complete until the tests and full quality gate pass.

**Verify**: `rg -n "people-directory|people directory|LinkedIn|profile" README.md docs/bainsa-discord-presentation-guide.md` → the new behavior and exclusions are discoverable; `npm run format:check` passes.

### Step 8: Run the full release gate and inspect scope

Run the repository’s complete local gate. Do not run live provisioning or migrations against a non-disposable database.

**Verify**:

```bash
npm run check
npm run build
npm run lint
npm run format:check
npm test
TEST_DATABASE_URL=postgres://localhost/bainsa_discord_test npm run test:integration
npm audit --omit=dev --audit-level=high
git diff --check
git status --short
```

Expected: every command exits 0; only files listed in Scope plus `plans/README.md` status are modified; no `.env`, `dist/`, credentials, generated artifacts, or unrelated issue changes are staged.

## Test plan

At minimum, add the following coverage using Node’s `node:test`/`assert` style and the repository’s existing dependency-injected fakes:

- **Pure state/validation**: every required/optional boundary, URL-host attack shapes, email normalization, exact taxonomy invariants, derived university tags, aggregate tag limit, maximum post size, Markdown and allowed-mention safety.
- **Components/session**: all modal/select/review paths, prefilled edit, cancel, expiry, owner/guild binding, inactive users, invalid replay, double submit, visibility notice, and optional contact rendering.
- **Repository/service**: publish upsert + generation increment, update, hidden republish, idempotent unpublish, audit minimization, transaction rollback, member fact revalidation.
- **Discord gateway**: create/update one starter message without duplicate appends, remove legacy managed follow-ups, map exact tag IDs, unarchive, delete, missing resources, recovery adoption, duplicate cleanup, and preserve the no-ping payload.
- **Reconciliation**: generation race, stale processing retry, failure metadata, startup retry, bounded maintenance, archived profiles/guide visibility, worker stop semantics.
- **Provisioning**: exact 15 managed directory tags, human read-only permissions, bot permissions, list layout, max auto-archive, first-run guide buttons, archived guide adoption, and no changes to other forums.
- **Lifecycle integration**: approval prompt failure isolation, canonical member updates, removal/departure, reapproval staying hidden, and fresh/idempotent migrations.
- **Regression**: existing onboarding, governance, project, dispatcher, provisioner, migration, reset, and service-boundary tests remain green; command registration contains no new profile/search command.

## Done criteria

All must hold:

- [ ] Migration `013_member_profiles.sql` applies on a fresh disposable database, upgrades the current schema, and is idempotently tracked without editing earlier migrations.
- [ ] `people-directory` is provisioned under `GLOBAL BAINSA` with list layout, approved-only visibility, read-only human permissions, and exactly the 15 managed tags above.
- [ ] `Start here` has working Create/update and Unpublish buttons on first and repeated provisioning, including after guide auto-archive.
- [ ] No slash command, command permission, autocomplete, or command registration entry was added.
- [ ] Only active approved members can start or submit their own profile flow.
- [ ] Incomplete/cancelled profile sessions never change public PostgreSQL or Discord state.
- [ ] A legal published profile contains every required field, zero to all optional contact fields, one derived BAINSA university tag, and one to four selectable tags.
- [ ] Publishing/editing creates or edits exactly one bot-owned profile message; retries never append duplicates or trigger mentions.
- [ ] Discord create/edit/delete failures persist retryable desired state and recover without duplicate profile threads.
- [ ] Unpublish, member removal, and guild departure durably hide the row and delete the forum post; reapproval does not auto-publish.
- [ ] Auto-archived profile and guide threads are returned to the browseable list without keep-alive messages.
- [ ] Audit/log output contains no biography, goals, emails, or profile URLs.
- [ ] Email and every external link are optional; phone/X/Instagram/LinkedIn import are absent.
- [ ] README and presentation guide accurately describe the shipped UX and v1 exclusions.
- [ ] Full unit/integration/quality gates in Step 8 exit 0.
- [ ] `git diff --check` is clean and `git status --short` shows no files outside Scope except the plan status update.
- [ ] `plans/README.md` marks Plan 001 DONE only after all criteria pass.

## STOP conditions

Stop and report back; do not improvise if:

- Any in-scope current-state excerpt materially differs after the drift check.
- Current official Discord/Discord.js documentation contradicts the assumed limits of 20 available forum tags, five applied tags, 1–5 modal components, bot-only content editing, 100-character thread names, 2,000-character message content, or 10,080-minute auto-archive.
- A true read-only-for-humans forum prevents approved members from using message buttons; verify this with a focused fake/test and, if necessary, a non-production Discord rehearsal before altering permissions.
- Keeping archived posts browseable requires sending messages, creating duplicate posts, or granting humans write access. Report the platform limitation and recommend reassessing the forum MVP versus a web directory.
- The live server already has enough active threads that keeping profiles active approaches Discord’s guild cap. Do not ship a worker that continually fails; report expected membership/thread counts and recommend a web-directory threshold.
- Correct synchronization appears to require a new queue/runtime dependency. The existing PostgreSQL generation worker is the required first approach.
- Profile publication cannot be made owner-authorized at the service/database boundary, or unpublishing cannot be made durably retryable.
- The implementation would require logging/storing additional personal data, making profile completion mandatory, or changing membership approval semantics.
- Any step’s verification fails twice after a reasonable scoped correction, or completion requires a file outside Scope.

## Maintenance notes

- Discord is the presentation/search surface; PostgreSQL is authoritative. Reviewers should reject any edit path that mutates only the forum post.
- The profile taxonomy is a product contract. Stable keys permit label changes, but deleting/reusing keys can invalidate published rows. When taxonomy changes, plan the database/backfill and Discord managed-tag reconciliation together and keep the total below 20.
- The forum MVP is appropriate while BAINSA remains small enough for active/browseable profile threads. Repeated active-thread-cap or search-quality problems are the explicit trigger for a Discord-authenticated web directory using the same structured fields—not for adding more slash commands.
- LinkedIn remains an outbound link. Any future import requires a separate official-API, consent, refresh, deletion, and failure-mode design; never add scraping inside this worker.
- The natural owner mention in the post is both useful contact UI and orphan-recovery identity. If the presentation changes, preserve a deterministic, non-secret recovery mechanism before removing it.
- Review the PR specifically for authorization replay, no-ping rendering, URL validation, generation races, post duplication after partial Discord success, member-removal privacy, and accidental profile content in logs/audit JSON.
