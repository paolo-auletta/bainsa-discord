# Deep Audit Remediation Program

Generated with the `improve` skill on 2026-07-19. The audited baseline is commit `3552f7a`.

This is the master tracker requested by the maintainer. Implementation is sequential in the isolated `codex/improve-all` worktree. Each stage is assigned to a fresh `gpt-5.6-terra` executor at high reasoning effort, then independently reviewed before the next stage begins. Executors own source edits; the advisor maintains this file and the plan statuses.

## Execution order and status

| Stage | Audit # | Plan | Priority | Effort | Depends on | Status | Review notes |
|---:|---:|---|---|---|---|---|---|
| 1 | 1 | [001-verify-postgres-tls.md](001-verify-postgres-tls.md) | P1 | S | — | DONE | APPROVE — `14a5a7c`; 139 tests pass. New shared options module accepted as necessary scope extension. |
| 2 | 7 | [002-enforce-quality-gates.md](002-enforce-quality-gates.md) | P1 | M | — | DONE | APPROVE after one revision — `446a8dd`, `f373d00`; full syntax gate fixed; 140 tests pass. |
| 3 | 6 | [003-postgres-integration-tests.md](003-postgres-integration-tests.md) | P1 | L | 002 | DONE | APPROVE after one revision — `1aee224`, `8d91584`; 142 unit + 6 integration tests pass twice. Found and fixed PostgreSQL parameter typing bug. |
| 4 | 2 | [004-preserve-project-eligibility.md](004-preserve-project-eligibility.md) | P1 | M | 003 | DONE | APPROVE — `84a09ea`; 149 unit + 7 integration tests pass; rejection precedes all side effects. |
| 5 | 3 | [005-atomic-onboarding-drafts.md](005-atomic-onboarding-drafts.md) | P1 | M | 003 | DONE | APPROVE after one test revision — `fedb8ae`, `9b6f68c`; all four race orderings covered; 11 integration tests pass. |
| 6 | 5 | [006-enforce-project-eligibility-boundary.md](006-enforce-project-eligibility-boundary.md) | P1 | L | 003, 004 | DONE | APPROVE after one race-matrix revision — `150a853`, `d23b0b8`; 151 unit + 14 integration tests pass. |
| 7 | 4 | [007-reconcile-project-discord-state.md](007-reconcile-project-discord-state.md) | P1 | L | 003, 006 | DONE | APPROVE after one implementation revision — `6d65247`, `d5a9642`, `bd1189a`; one-shot history preserved outside replay; 153 unit + 19 integration tests pass. |
| 8 | 8 | [008-bound-project-participants.md](008-bound-project-participants.md) | P2 | M | 007 | DONE | APPROVE after one verification revision — `4d6dd29`, `d2a753d`; official 1,000-overwrite limit documented; cap races proven; 157 unit + 21 integration tests pass. |
| 9 | 9 | [009-batch-member-reconciliation.md](009-batch-member-reconciliation.md) | P2 | M | 002 | DONE | APPROVE after one failure-contract revision — `17c9ef9`, `ffce610`; deterministic concurrency-three Discord work, set-based DB transaction, rollback/retry diagnostics; 160 unit + 23 integration tests pass. |
| 10 | 10 | [010-secure-command-autocomplete.md](010-secure-command-autocomplete.md) | P2 | M | 002 | DONE | APPROVE — `0c2d5b1`; official Bearer-token permission sync and interaction context verified; pre-lookup tier/scope guard; 163 unit + 23 integration tests pass. |
| 11 | 11 | [011-split-service-orchestrators.md](011-split-service-orchestrators.md) | P3 | L | 004–010 | DONE | APPROVE — `24cd258`; public API contracts, module boundaries, and behavior-preserving extraction verified; 167 unit + 23 integration tests pass. |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED`, `REJECTED`.

## Program-wide verification

After every stage:

- `npm run check` must exit 0.
- `npm test` must exit 0 with all tests passing.
- The executor must change only files allowed by that stage's scope.
- The reviewer must read the full stage diff and all new or modified tests.

After stage 11:

- Run `npm ci`, `npm run check`, `npm test`, and `npm audit --omit=dev` in the isolated worktree.
- Review `git diff --check` and the complete branch diff from `3552f7a`.
- Confirm no credential values or `.env` contents entered the diff.
- Confirm documentation matches the resulting commands and operational requirements.

## Dependency notes

- Stage 3 establishes real PostgreSQL verification before concurrency and transaction invariants are changed.
- Stages 4 and 5 characterize the two user-visible consistency bugs before the database-boundary work in stage 6.
- Stage 7 depends on stable database invariants because it introduces durable reconciliation around committed project state.
- Stage 11 is deliberately last: moving orchestration code before behavior is tested would make later defects harder to localize.

## Considered and rejected during audit

- Immediate project-autocomplete indexing was rejected pending representative `EXPLAIN (ANALYZE, BUFFERS)` evidence; wildcard search may not yet justify write-amplifying indexes.
- A generic workflow framework was rejected. Stage 11 must extract stable boundaries without inventing a cross-domain abstraction.
- Unbounded parallel Discord calls were rejected as a performance strategy; all concurrency introduced by these plans must be explicitly bounded.
