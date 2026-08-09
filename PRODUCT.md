# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

All members inside the BAINSA Discord are primary users. New arrivals use the read-only START
HERE area and onboarding flow. Approved Researchers and Alumni participate in global and
university communities; Researchers may also work in divisions. Project participants use private
project channels. University Presidents, Vice Presidents, and Division Heads are members with
additional scoped governance access, while Global Presidents coordinate across universities.

## Product Purpose

BAINSA is a network of university chapters using one shared Discord community. The bot makes the
network usable and safe by automating onboarding, member access, divisions, board appointments,
private projects, people-directory profiles, and the supporting Discord structure. Success means
members can find the right community and collaborate, while each university can run its own work
without exposing the whole association to arbitrary or destructive administration.

## Positioning

The Discord is the digital operating system for a federated association: it gives every university
its own working space while connecting approved members through a smaller set of global spaces.
Instead of granting chapter leaders raw Discord administration, the bot encodes BAINSA's governance
model as scoped, least-privilege workflows. Universities retain meaningful self-management, but
destructive structural changes are mediated by the bot and durable changes are auditable in
PostgreSQL.

## Operating Context

The product runs inside a Discord guild with global BAINSA spaces, university categories, division
channels, private project channels, governance-only board areas, onboarding review, bot logs,
administrative logs, and bot-managed forums for resources, project showcases, and the opt-in people
directory. Work should stay in the narrowest useful scope: project work in project channels,
division work in division spaces, university matters in university areas, and only network-wide
matters in Global BAINSA.

The main workflows are private onboarding and board approval; role and access reconciliation;
division and board management; guided project creation and lifecycle management; profile creation,
publication, update, and unpublishing; role-aware `/guide` navigation; and concise board-visible
activity entries backed by a complete PostgreSQL audit record.

## Capabilities and Constraints

- Approved members have exactly one base member type: Researcher or Alumni. Researchers may belong
  to one or more divisions; Alumni do not need a division.
- University and division roles scope visibility. Board authority is scoped by university and,
  for Division Heads, by division. Global Presidents can operate across universities.
- Governance and project-creation slash commands are available in the appropriate `bot-log`.
  Project participants can also use project-scoped commands inside their private project channel:
  every participant may inspect project information, while supervisors and scoped board roles may
  manage that project. Client-side command visibility and autocomplete are usability layers;
  server-side authorization remains authoritative.
- The bot must not grant `Administrator` or expose unrestricted destructive permissions. It owns
  structural changes, preserves least privilege, and records governance mutations.
- PostgreSQL is the durable source of truth. Discord changes are reconciled idempotently and may
  remain pending after a committed database change; retries must not duplicate one-shot history
  messages.
- Projects are private, university- and division-scoped in v1. Cross-university projects, broad
  maintenance or deletion commands, and member-requested board roles are outside v1.
- The people directory is opt-in, Discord-native, and visible to approved members. Discord DM is
  the default contact path; external tables, LinkedIn scraping/import, endorsements, and staff
  editing of another member's profile are not v1 capabilities.
- Discord platform limits shape the model, including role/channel/thread limits and the 1,000
  permission-overwrite limit. Project channels reserve six overwrites and therefore support at
  most 994 direct participants.
- The existing implementation uses TypeScript 6, Node.js 22, discord.js 14, PostgreSQL through
  `pg`, explicit migrations, and Node's test runner. Production runs compiled JavaScript only.
- The supported deployment requires a Discord application with the bot and
  `applications.commands` scopes, Server Members Intent, a correctly positioned bot role, and
  verified TLS for remote PostgreSQL connections.
- Open product decisions include creating whole new universities through the product and any
  future external directory or contact integrations.

## Brand Commitments

The product name is BAINSA and the repository includes the current bot icon at
`assets/bainsa-bot-icon.png`. The product must preserve BAINSA-wide principles and values while
supporting university-specific autonomy. Existing university, division, and board vocabulary is
part of the product language and should not be casually renamed.

## Evidence on Hand

- `README.md` documents the implemented v1 server model, onboarding, projects, people directory,
  commands, operations, and deployment requirements.
- `docs/bainsa-discord-presentation-guide.md` records the intended operating model, information
  architecture, role layers, access boundaries, and the principle of making local autonomy safe,
  understandable, and scalable.
- `docs/commands.md` and `docs/guide-and-activity-log.md` document command scope, privacy, guide
  behavior, and board activity rules.
- `docs/engineering-invariants.md` records durable authorization, transaction, reconciliation,
  bounded-work, migration, and test-isolation requirements.
- `docs/production-roadmap.md` records deployment separation, launch-content, and production
  acceptance expectations.
- `plans/README.md` and `plans/001-bot-managed-people-directory.md` record the completed v1
  people-directory direction and deliberate non-goals.
- No external testimonials, benchmarks, pricing, or other proof claims are established; future
  work must not fabricate them.

## Product Principles

1. Every approved member should have a clear, useful place in the shared BAINSA network.
2. Give each university as much self-management as possible while keeping BAINSA-wide safeguards.
3. Use least privilege and mediate destructive structural changes through the bot.
4. Prefer Discord-native, guided workflows that automate repetitive administration without hiding
   important state.
5. Keep durable state, privacy boundaries, and audit history explicit and recoverable.
