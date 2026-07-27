# Plan 004: Preserve active-project eligibility during member updates

> **Executor instructions**: Implement only this plan. Prefer rejecting incompatible membership updates with an actionable message; do not silently remove project assignments.

## Status

- **Execution**: DONE — approved commit `84a09ea`; reviewer read the guard/tests, reran all gates, and verified seven real-Postgres tests.
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 003
- **Category**: bug
- **Planned at**: commit `3552f7a`, 2026-07-19

## Why this matters

`/member-update` can change a person's university, member type, or divisions without checking active `project_people`. Because project channels grant direct user overwrites, an ineligible person can retain private access.

## Current state

- `src/services/governance/service.mjs:713-763` applies role and membership changes without project validation.
- `src/services/governance/service.mjs:693-711` already rejects direct division removal when active project access would be lost; match this user-facing pattern.
- `src/services/projects/index.mjs:505-524` stores project people and refreshes direct overwrites.

## Scope

**In scope**: `src/services/governance/service.mjs`, focused governance tests, integration fixtures/tests from Plan 003, and command docs if behavior needs clarification.

**Out of scope**: automatic reassignment/removal, project reconciliation architecture, completed/archived projects, and new commands.

## Steps

1. Before any Discord role mutation, compute whether the proposed university/type/division state preserves eligibility for every active or paused project assignment.
2. Reject incompatible changes with project names/IDs and a clear instruction to remove/reassign project participation first.
3. Preserve updates unrelated to eligibility, including notes-only updates and compatible division sets.
4. Add tests for Researcher→Alumni, university move, division removal, supervisor compatibility, multiple projects, and compatible/no-op updates.

## Verification

- Focused governance tests → all new cases pass.
- Disposable-Postgres membership/project tests → all pass.
- `npm run check && npm test` → exit 0.
- `git diff --check` → exit 0.

## STOP conditions

- Product rules require automatic project removal instead of rejection.
- Existing data contains active assignments that cannot be classified under current member/supervisor/liaison rules.
- Validation can only occur after Discord roles are mutated.

## Maintenance notes

Any future project-person role must be added to this compatibility check. Keep the validation query and the project write-boundary invariant aligned.
