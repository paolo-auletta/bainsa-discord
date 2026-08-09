# Journey 2 — Approved member space discovery

## Decision

Keep the global → university → division hierarchy and the existing channel names. Add a durable
arrival layer around it so new access reads as an intentional invitation rather than a changed
sidebar.

## Member experience

1. Approval DM identifies the member’s path, university, and division and links to Global general,
   university general, and (for Researchers) the division room.
2. A dedicated **Find my spaces** guide remains available in `#welcome`. It is a channel map, not an
   application status: it gives Alumni and Researchers a deliberate arrival, introduces global
   resources, project showcases, and the people directory, and provides a recovery route when DMs
   are unavailable.
3. Every normal channel gets a Discord channel topic and a pinned, bot-managed purpose message.
   Topics deliver immediate scope; pins retain the fuller posting contract after conversation grows.
4. Provisioning reconciles the category and channel order on every run: public member spaces first,
   division text/voice pairs next, then private board operations. This creates one durable pattern
   across universities without adding a second hierarchy.
5. Every topic and pinned heading names its scope (`GLOBAL BAINSA` or `BAINSA <UNIVERSITY>`).
   This preserves concise local names like `#general` while giving Global Presidents a dependable
   scope check before they act.

## Boundaries

- No roles, permission overwrite rules, channel names, or visibility rules change.
- No personalised channels are created; the reusable `#welcome` control avoids a per-member
  structural footprint.
- Voice rooms retain their paired placement but do not receive text-only channel topics.

## Acceptance checks

- An approved Researcher can reopen a card linking global, university, and division workspaces.
- An approved Alumni can reopen a card linking global and university workspaces without implying a
  missing division.
- A member can tell a channel’s scope and posting boundary from its topic or pinned guide.
- A provision run restores the approved category and in-category ordering after manual movement.
- A Global President sees the university name in local channel topics and pinned guidance.
