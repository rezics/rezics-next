---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
# Migrations are not listed: each task reserves its own numbers. Route files are
# claimed by the task that owns their behaviour. The manager widens areas as briefs land.
areas:
  - services/account/**
  - apps/accounts/**
  - services/main/src/modules/access/**
  - services/main/src/modules/account/**
  - services/main/src/modules/rate-limit/**
  - services/main/src/modules/disclosure/**
  - services/main/src/modules/suitability/**
  - services/main/src/modules/protection/**
  - services/main/src/modules/erasure/**
  - services/main/src/modules/rights/**
  - services/main/src/modules/media/**
  - services/main/src/modules/media-rendition/**
  - services/main/src/modules/media-screen/**
  - services/main/src/modules/safety-alerts/**
  - services/main/src/modules/safety-queue/**
  - services/main/src/modules/governance/**
  - services/main/src/infrastructure/pg-pool.ts
  - scripts/ops/*.ts
  - scripts/ops/tests/**
  - infra/release/**
  - infra/jena/purge-tdb2.sh
---

# Trust and operations

Status: designed on 2026-10-07; [state.md](state.md) records where the work
stands. The [program](../program/GOAL.md) holds main-wide regression, the
contracts board and shared resources.

## Outcome

Authority is decided in one place and stays correct under revocation, expiry and
handover. Every operation that is not public is closed behind a platform
permission. Safety, erasure and recovery have evidence, and deployment is
prepared so that going live is operations work.

- **Common admission (C1).** The published policy, mandatory restrictions,
  representation, grants and capability eligibility are judged in one place at
  register, retry and claim; leases end no later than the earliest expiry of the
  authority they rest on. Management follows the current controller and
  steward, never the provisioning principal, and every change that affects the
  effective controller keeps the continuity invariant.
- **Platform gates (maintainer, 2026-10-07).** "所有需要打磨的，都可以暫時不開放，然後我們逐步完善，逐步開放." Each operation declares `exposure` beside its
  route: `public`, or `platform:<group>`; a missing declaration is closed. A
  closed operation admits only principals or groups holding the Access grant
  `platform:use:<group>` (or `platform:use:<operationId>`). The grant
  `platform:grant` can grant and revoke any `platform:*` permission within the
  assignment ceiling, and the last holder cannot be removed. The gate binds to
  the server-selected template or command, so a generic operation such as
  `/v1/query` or a generic edit cannot reach a closed capability. Opening a group
  changes its declaration, not the code path; generated OpenAPI, SDK and MCP
  mark or hide closed operations, and the web reads a bounded summary of the
  viewer's open groups while the API still enforces. The hard-coded action list
  in `access/platform-administrator.ts` becomes grants. No separate
  feature-flag service. Record §9 has the design.
- **Launch operation matrix.** With launch's input, propose which operations
  and groups are public for the first scope (launch GOAL.md); the program
  approves. List the foundation that must stay public to avoid a lockout:
  sign-in, sessions, recovery, public reads of public resources, health.
- **Accounts.** Recovery revokes or rebinds old passkeys and TOTP; a guardian is
  invited, accepts and can withdraw; email target budgets are spent only after
  Turnstile passes; deleting an account is an operation with visible progress.
- **Budgets and pools.** Verified search is charged like every principal class;
  `service` accepts only verified workload principals; classification before
  heavy queries is bounded; every pool checkout has a wait limit
  (`connectionTimeoutMillis`) and no caller borrows a second client from the
  pool it holds.
- **Safety, erasure, recovery.** Private draft covers never become public; a
  saved image's NSFW label can be corrected through an authorized revision; the
  required safety matcher has a real outage adapter. Suppression takes effect
  at once; active stores delete within 30 days; backups age out within 90 days
  and a restore replays the erasure journal first; the UI shows suppressed,
  retained, destroyed and blocked apart. Physical clean-up runs as a batched
  maintenance campaign, never as a whole-graph copy per revision.
- **Deployment preparation.** Images, bootstrap of the launch catalogue,
  consistent backup and timed restore, the TDB2 compaction procedure, email
  operations, legal configuration within the zero-budget decision, safety
  drills and named responders. Stripe stays the hard gate before any sale.

## First wave

Drafts from D2 (`.temp/goal-design/raw/D2-goal-decomposition.md`); real IDs come
from `task goal -- new`.

| Draft | Outcome | Engine; depends |
| --- | --- | --- |
| T1 | Policy inside admission at register, retry and claim; lease deadline from the earliest authority expiry; reuse the existing witness | `codex-1` xhigh |
| T2 | Controller and stewardship continuity; disabling a principal cannot strand the last controller | `codex` xhigh; T1 |
| T3 | Recovery revokes and rebinds passwordless, passkey, TOTP, sessions and tokens | `codex-1` xhigh |
| T4 | Guardian consent lifecycle; email budget after Turnstile | `codex` high; T3 |
| T5 | Platform gates thin slice: `exposure` beside routes, closed by default, saved views as the first group, `platform:use:*` and `platform:grant` on existing grants | `codex-1` xhigh; T1, T2 |
| T6 | Principal budgets and pool waits | `codex` high; T1 |
| T7 | Media safety: draft covers, label correction, required matcher outage | `codex-1` high; T1 |
| T8 | Suppression and restore first: one component's erasure, journal and restore admission | `codex` xhigh; T1, kernel K5 (C6) |

Deployment artifacts, the production bootstrap, email, legal and responder
drills and a full security review form the second wave; take inventory of the
external conditions from the start.

## Inherited

- First-round review (`.temp/arch-review/README.md`), re-verify before fixing:
  the policy and admission findings, claim expiry, provisioning principal,
  controller continuity, recovery factors, guardian, Turnstile ordering, email
  existence signals, search exemption, `service` misclassification, unbounded
  classification before queries, token cache, pool waits. `authority-witness.ts`
  already checks the chosen grant's `valid_until`; the fixed 30-second admission
  expiry still needs the earliest-expiry rule.
- addresses-discovery: required safety-matcher outage admission (M8 drills);
  the TDB2 compaction procedure (maintenance window, disk peak, recovery, old
  copy retirement).
- showcase: batched author proofs for `POST /v1/resources/showcase`; correcting
  a saved image's NSFW label; a removed logo language still counting toward the
  eight-language limit.
- write-concurrency: production PostgreSQL grants `pg_read_all_stats` and sets
  `max_prepared_transactions=0`; long migrations measured on a populated
  restore; share-then-update lock upgrades beyond scope gates and a deadlock
  alert.
- scoped-subjects: migration 1080 versus older writers in a rolling deploy
  (unreleased baselines can remove the need; do not promise rolling writes from
  old binaries).
- Salvage: `goal/g-435` moderation and authority work (review against the
  current Access model; launch reviews its admin UI).

## Cut lines

No feature-flag service, operation registry runtime or second policy evaluator;
no Solid WAC/ACP, ODRL enforcement or OpenFGA/SpiceDB in v1; no per-resource
permission fan-out; no second identity provider. Public descriptions of roles
(moderator, member) never grant authority.

## Completion

C1 and the platform gates land with acceptance on the program's board, the
launch matrix is approved and enforced, the inherited items are closed or
re-verified as gone, and deployment is ready as
`docs/operations/deployment.md#ready-to-deploy` records.
