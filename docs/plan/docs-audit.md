# Documentation-to-code audit

Audited 2026-09-27 at `cb7dcb0b673e9b965baf04ad307a298761a058d6` for G-201.
The baseline is **175 Markdown pages / 27,314 lines**: 173 pages under `docs/`
plus root `README.md` and `AGENTS.md`. Every baseline page appears exactly once
below. Counts use physical lines before this audit's required navigation link.
The audit itself and the executable 47-line Turtle companion have separate rows.
`GOAL.md`, skills, owner READMEs and research artifacts were inspected as consumers
where needed; they are outside the requested page inventory.

Baseline verdicts: **93 encode, 59 shorten, 11 merge, 8 keep, 3 archive, 1 delete**.
The shortened pages have a combined target of at most 3,150 authored lines;
generated tool tables are additional. This is a migration target, not a claim
that unimplemented requirements can already be removed. All tests named below
are source/evidence destinations; this audit does not rerun backend qualification.

## What each verdict authorizes

- `delete`: the opened implementation and tests already carry the page's
  operative rules. Remove it once incoming links have a replacement.
- `encode`: reconcile every normative scenario against the named types,
  schemas, fixtures, tests or comments, add the missing executable contract,
  then delete the page. Existing test coverage may supply most of the work.
  A title prefix or coverage declaration alone does not prove every assertion.
- `shorten`: keep only the stated intent, decision reasons or operating steps,
  within the row's target length; transfer concrete rules to its code owner.
- `keep`: retain the identified non-code purpose; repair links as necessary.
- `merge`: preserve the unique content in the named destination, then remove
  the original. Destination target lengths include merged prose unless noted.
- `archive`: the manager preserves the exact dated record on `archive/goals`
  before removing active-tree copies and links.

Paths in code spans are repository-relative. A directory or glob identifies an
existing owner; `new`, `future` and `pending` explicitly identify proposed work.
Targets are never handwritten edits to generated model/OpenAPI output. Use the
authored definitions/routes, and let integration regenerate derivatives.

## Prerequisites and facts that change the plan

1. **QA currently consumes documents.** `caseInventory` in
   `scripts/qa/acceptance.ts` parses table rows in `docs/testing/*.md`.
   `scripts/qa/backend-scope.ts` fingerprints ID plus page path and retains
   276 of 277 cases. `tests/qa/unit/backend-operation-map.test.ts` separately
   parses `docs/plan/backend-operations.md` and checks routes against OpenAPI.
   B00 replaces both prose inputs with typed owner case/operation declarations.
   Its migration test compares every old ID, scenario and owner before any
   deletion; retain VIEW04's frontend exclusion and existing evidence identities.
   `scripts/qa/coverage.ts` and `scripts/qa/cli.ts` also generate/link the current
   qualification page and must change before its archival.
2. **A docs-only diff can hide runtime impact.** `scripts/qa/affected.ts`
   ignores Markdown. Deleting a parsed case table therefore selects no backend
   tests even though it can break qualification. Run the explicit inventory,
   scope, operation-map and recording regressions during the transition; once
   those inputs are code-owned, normal import-based selection can follow them.
3. **One file under docs is executable configuration.** Tests copy or inspect
   `docs/operations/examples/fuseki-text.ttl`: the quickstart fault test,
   `services/main/tests/search-private.test.ts`, five legacy Main integration
   files and Account's access-recovery integration test. B28 moves its consumers
   together. The guarded production assembler has a different purpose.
4. **Some detailed prose is already stale.** The opened Cargo solver is
   `services/main/src/modules/package/cargo-solver.ts`, implemented in TypeScript;
   the package blueprints still prescribe a Rust solver service. Root/plan and
   many owner pages still say Content binding or backend qualification is pending,
   although the recorded phase-1 page supplies the dated result. Preserve the
   recorded result's actual scope: full performance verification, the 500M corpus
   and production destruction evidence for OPS10 remain later work.
5. **Prospective requirements must survive.** The media/presentation pages
   explicitly mark the 2026-09-27 emoji/icon, cover/banner and Post preview work
   as unimplemented. Generic messaging, durable likes/favorites, identity split,
   Turnstile integration, spatial clients and hostile-code hosting also cannot
   be inferred from nearby code. Transfer requirements to explicit pending
   cases/profile metadata, retain any residual prose until its contract is
   carried, and propose a separate feature brief for missing behavior. Do not
   turn such cases into passing declarations or weaken a qualified denominator.
6. **One direct deletion is verified.** For Work title control, the audit opened
   `titleControlDigest`, `readTitleControl`, `titleControlCommand`, native
   `TitleControlPolicy` and `reconcileRetainedTitleControl`, plus the named
   integration/fault assertions. They cover exact bases, same-byte human takeover,
   forbidden source overwrite, denied return, replay/conflicting digest, forged
   admission, immutable revisions, bounded unrelated growth and held-owner restore.
   The older page's blanket rejection of any protection head has already been
   superseded by the native Open-protection check.

## Execution and integration

B00 comes first because it unlocks acceptance-page retirement. The next batches
prioritize large duplicated specifications and decision reports. Independent
owners can proceed in parallel; frontend-owned rows go to the frontend Goal,
which is reconsidering their design. B37 archives finished records; B38 finishes
navigation and eventually archives this audit.

Each batch below supplies exact document claims and candidate additional code
globs. Claim only the necessary subset of those code globs in a dispatched brief.
The intended sitting is contract extraction, a small missing assertion/comment
and prose reduction. Split substantial missing runtime behavior into a feature
brief; it is not hidden work inside a documentation-cleanup estimate.

Every batch runs `task docs:check`. Listed owner checks are additional when code,
fixtures or their inputs change. Run each listed command separately
and keep QA tiers separate. Replace frontend `<changed ...>` placeholders with
explicit files selected by its delivery brief, and review actual screenshots and
browser flows for visible changes. Use the Goal QA slot for runtime checks where
the worker's filesystem authorization permits it; a read-only affected-plan
preview and this audit's documentation check need no shared stack. When schemas
change, run the owner's typecheck and generated-integrity checks as well.

The same code owner appears in several batches. Serialize B05/B06/B10 (packages),
B08/B09/B16 (Access/Account), B18 and domain profile edits, and B20/B21/B31
(publication/composition/media) wherever claims overlap. B27 dispatches one
owner's workload metadata at a time after its corresponding domain extraction;
it does not implement seven performance campaigns in one sitting.

### Links and conflict avoidance

The high-contention hubs are `docs/README.md`, `docs/architecture/README.md`,
`docs/architecture/coverage.md`, `docs/contracts/README.md`,
`docs/contracts/data-contract-map.md`, `docs/implementation/README.md`,
`docs/services/README.md`, `docs/storage/README.md`, `docs/testing/README.md`,
`docs/research/README.md` and `docs/plan/README.md`. Root README/AGENTS/GOAL,
skills and owner/research READMEs also contain deep page/fragment links.

Use **one serialized integration link slot**, owned by the manager or one brief,
instead of letting each owner edit those hubs. Replacement workers commit code
first and supply a path-and-fragment replacement map in their handoff. Keep the
old linked pages/anchors intact until the link editor can apply their removal,
all incoming-link repairs and retained-page shortening in the same integration
commit. That commit runs `task docs:check` before the batch is called complete.
This permits passing intermediate commits without permanent redirect stubs or
checker exemptions. B38 performs final hub consolidation; it is not an excuse
to merge broken links throughout the earlier waves.

Search both Markdown destinations and literal paths in source/tests/skills for
each retired page and heading. Repoint a schema/API link to its authored code or
generated contract; repoint a reason/procedure link to the surviving decision or
runbook. Archive references identify branch, source commit, path and run ID;
they must not remain local links to missing working-tree files. Maintainer edits
are authoritative: recheck the page before applying the retirement mapping.

## Page inventory and claimable batches

### B00 — Remove Markdown from the QA input path

Document claims: `docs/plan/backend-operations.md`, `docs/plan/backend-acceptance.md`.

Additional claimable paths: `scripts/qa/acceptance.ts`; `scripts/qa/backend-scope.ts`; `scripts/qa/coverage.ts`; `scripts/qa/cli.ts`; `scripts/qa/cases/**` (new); `tests/qa/unit/acceptance.test.ts`; `tests/qa/unit/coverage.test.ts`; `tests/qa/unit/backend-operation-map.test.ts`; `tests/qa/unit/core.test.ts`.

Checks: `task test -- tests/qa/unit/acceptance.test.ts tests/qa/unit/coverage.test.ts tests/qa/unit/backend-operation-map.test.ts tests/qa/unit/core.test.ts`.

Prerequisite for every acceptance-page retirement and B37 qualification archival. Preserve all 277 IDs, the 276-case backend selection, VIEW04 exclusion and scenario assertions; moving ownership must not shrink the denominator. Keep legacy page identity as provenance until the fingerprint migration is explicitly reviewed. Make qualification output link to existing code or artifacts, not retired Markdown.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/plan/backend-operations.md` | 160 | `encode` | New typed operation references in `scripts/qa/cases/**`; generated/openapi/main/public.json; `tests/qa/unit/backend-operation-map.test.ts` | Replace the Markdown-parsed E/P route matrix with checked route/operation references, preserving planned versus installed status. |
| `docs/plan/backend-acceptance.md` | 83 | `encode` | `scripts/qa/backend-scope.ts`; `scripts/qa/cases/**` (new); `tests/qa/unit/acceptance.test.ts` | The scope denominator, exclusions and owner mapping belong in the registry; retain historical qualification limits in the short plan. |

### B01 — Condense the storage decision

Document claims: `docs/research/storage-architecture.md`.

Checks: `task docs:check`.

Highest single-page reduction: retain the decision and its reasons; remove copied target schemas and workflow specifications. Do not rerun the research lab for a prose reduction.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/research/storage-architecture.md` | 1802 | `shorten` | `services/content/src/`; `services/main/src/modules/content-publication/`; `scripts/research/storage_architecture/` | Target ≤140 lines: selected Content/Jena split, rejected alternatives, measurement provenance and conditions for reopening the choice; remove obsolete P0.8 implementation plans. |

### B02 — Condense Access decision evidence

Document claims: `docs/research/access-depth-representation-and-voting.md`, `docs/research/access-storage-and-policy.md`.

Checks: `task docs:check`.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/research/access-depth-representation-and-voting.md` | 692 | `shorten` | `services/main/src/modules/access/representations.ts`; `services/main/src/modules/vote/schema.ts`; historical probes under `scripts/research/` | Target ≤100 lines: why representation and conserved entitlements are separate, alternatives and unmeasured depth/99% coverage limits; remove repeated schemas and scenarios. |
| `docs/research/access-storage-and-policy.md` | 461 | `shorten` | `services/main/src/modules/access/policy-evaluator.ts`; `services/main/src/modules/access/policy-transaction.ts`; `scripts/research/` | Target ≤80 lines: PostgreSQL selection, coherent-snapshot rationale and scoped comparison evidence; remove the implemented policy blueprint. |

### B03 — Replace the repository and tool inventories

Document claims: `docs/development/toolchain.md`, `docs/development/repository-structure.md`.

Additional claimable paths: `scripts/dev/config.ts`; `scripts/dev/commands.ts`; `scripts/documentation/**`; `scripts/static/**`; .dependency-cruiser.json; package.json; Taskfile.yml.

Checks: `task docs:check`, `task test -- tests/qa/unit/static-gates.test.ts scripts/dev/config.test.ts`.

No tool adoption is proposed. Generate version/command tables from existing manifests, Task and image pins; retain the toolchain page as the maintainer-required entry point. Claim individual generator or lint files after choosing the smallest implementation.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/development/toolchain.md` | 480 | `shorten` | package.json; yarn.lock; Taskfile.yml; `scripts/dev/config.ts`; `infra/dev/compose.yaml`; new checked inventory generator in `scripts/documentation/` | Target ≤100 authored lines plus generated tables: prerequisites, pin-update procedure and non-obvious installation exceptions; eliminate manually copied commands and versions. |
| `docs/development/repository-structure.md` | 369 | `shorten` | .dependency-cruiser.json; package.json workspaces; `scripts/static/`; `model/compiler/outputs.ts` | Target ≤40 lines: reasons for owner boundaries and generated/authored separation; enforce imports/layout in lint instead of retaining the proposed directory tree. |

### B04 — Put search protocols beside search code

Document claims: `docs/contracts/search.md`, `docs/research/private-search-admission.md`, `docs/testing/search.md`, `docs/contracts/related-reads.md`.

Additional claimable paths: `services/main/src/modules/work/search-*.ts`; `services/main/src/modules/content-publication/search-*.ts`; `services/main/src/routes/search.ts`; `tests/qa/unit/search-*.test.ts`; `tests/qa/integration/search-*.test.ts`; `scripts/qa/cases/search.ts` (new).

Checks: `task main:typecheck`, `task test -- tests/qa/unit/search-budgets.test.ts tests/qa/unit/search-continuation.test.ts tests/qa/unit/search-multifield.test.ts`, `task test -- tests/qa/integration/search-title-body-native.test.ts tests/qa/integration/search-grouped-native.test.ts`.

After B00. Preserve private delivery limitations and unmeasured physical-work qualifications. This batch transfers contracts and assertions; implementing an additional search lane is a separate feature brief.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/search.md` | 775 | `shorten` | `services/main/src/modules/work/search-budget.ts`, search-joined.ts, search-grouped.ts, search-multifield.ts; `services/main/src/modules/content-publication/` | Target ≤60 lines: why graph-integrated text and exact Content projection were selected; move lane limits, continuation shapes and failure tables into types and owner tests. |
| `docs/research/private-search-admission.md` | 312 | `shorten` | `services/main/tests/search-private.test.ts`; `tests/qa/unit/private-node-http-delivery-fence.test.ts`; `tests/qa/unit/private-websocket-delivery-fence.test.ts` | Target ≤50 lines: transport choice, rejected fence mechanisms and the actual delivery boundary; remove the obsolete implementation brief and copied test results. |
| `docs/testing/search.md` | 187 | `encode` | `scripts/qa/cases/search.ts` (new); `scripts/qa/coverage/search*.ts`; `tests/qa/integration/search-*.test.ts`; `tests/qa/fault-recovery/search-*.test.ts` | Move SEARCH01–20 descriptions and residual obligations into typed cases and assertions; keep logical bounds distinct from measured cost. |
| `docs/contracts/related-reads.md` | 22 | `encode` | `services/main/src/modules/graph-query/`; `services/main/src/modules/work/search-continuation.ts`; `tests/qa/unit/graph-query.test.ts` | Put same-occurrence correlation, bounded hydration and generation-bound pagination in query types and adversarial tests, then retire the page. |

### B05 — Encode package profile semantics

Document claims: `docs/contracts/package-profiles.md`.

Additional claimable paths: `services/main/src/modules/package/*-resolution.ts`; `services/main/src/modules/package/*-schema.ts`; `services/main/src/modules/package/*-semver.ts`; `services/main/src/modules/package/mod-profile.ts`; `tests/qa/unit/*-resolution.test.ts`; `tests/qa/unit/mod-profiles.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/unit/cargo-resolution.test.ts tests/qa/unit/npm-registry-resolution.test.ts tests/qa/unit/go-mvs.test.ts tests/qa/unit/mod-profiles.test.ts`.

Serial with B06/B10 when they touch the same package tests. Preserve each native oracle/version and unsupported clause explicitly; no new resolver or package ecosystem is part of the conversion.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/package-profiles.md` | 627 | `encode` | `services/main/src/modules/package/cargo-solver.ts`, npm-resolution.ts, go-mvs.ts, nix-resolution.ts, mod-profile.ts; native-oracle fixtures in `tests/qa/fixtures/` | Replace the 627-line semantic inventory with adapter capability types, native-comparison fixtures and comments explaining divergences; retain upstream source references beside those cases. |

### B06 — Replace the package acceptance ledger

Document claims: `docs/testing/packages.md`.

Additional claimable paths: `scripts/qa/cases/packages.ts` (new); `scripts/qa/coverage/pkg-*.ts`; `tests/qa/unit/*-compatibility.test.ts`; `tests/qa/fixtures/*-live-scenarios.ts`; `tests/live/mod-public-provider.test.ts`.

Checks: `task test -- tests/qa/unit/acceptance.test.ts tests/qa/unit/coverage.test.ts tests/qa/unit/package-divergence.test.ts`, `task test -- tests/qa/integration/package-lock-go-cargo.test.ts tests/qa/integration/npm-registry-api.test.ts`.

After B00/B05. This is extraction and scenario reconciliation, not an instruction to perform live provider acquisition. Keep the deferred CurseForge/Steam decisions in their existing low-priority pages.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/testing/packages.md` | 728 | `encode` | `scripts/qa/cases/packages.ts` (new); `scripts/qa/coverage/pkg-*.ts`; `tests/qa/fixtures/`; `tests/live/mod-public-provider.test.ts` | Preserve PKG01–20, authored-versus-live distinctions, native oracle versions and unsupported outcomes in executable fixtures/metadata; remove repeated run narratives. |

### B07 — Retire the source/title protocol duplication

Document claims: `docs/contracts/source-lifecycle.md`, `docs/contracts/work-title-control.md`, `docs/contracts/names-and-authority.md`.

Additional claimable paths: `services/main/src/modules/source/field-*.ts`; `services/main/src/modules/source/support-attach.ts`; `services/main/src/modules/work/title-control.ts`; `tests/qa/integration/source-field*.test.ts`; `tests/qa/integration/work-title-control.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/integration/source-field.test.ts tests/qa/integration/source-support-attach.test.ts tests/qa/integration/work-title-control.test.ts`, `task test -- tests/qa/fault-recovery/work-title-control.test.ts`.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/source-lifecycle.md` | 668 | `shorten` | `services/main/src/modules/source/acquisition-run.ts`, field-control-native.ts, child-correspondence.ts, support-attach.ts; `tests/qa/integration/source-field.test.ts` | Target ≤60 lines: intake/reuse policy and why observation, support and human control differ; encode reservations, correspondence and recovery contracts beside the implementations. |
| `docs/contracts/work-title-control.md` | 49 | `delete` | `services/main/src/modules/work/title-control.ts`, reconcile-title-control.ts; `infra/jena/command-module/src/main/java/com/rezics/jena/TitleControlPolicy.java`; `tests/qa/integration/work-title-control.test.ts`; `tests/qa/fault-recovery/work-title-control.test.ts` | Opened owners enforce exact heads, same-value takeover, return authority and recovery; the G-028 prose also predates the implemented Open-protection handling. |
| `docs/contracts/names-and-authority.md` | 52 | `encode` | `services/main/src/modules/catalog/`; `services/main/src/modules/source/field-schema.ts`; `services/main/src/modules/protection/field-control.ts`; `tests/qa/integration/catalog-descriptions.test.ts` | Make name occurrence, provenance, language and authority distinctions schema/test obligations; title-only control must not stand in for general name protection. |

### B08 — Move the identity contract into Access types

Document claims: `docs/contracts/identity-and-access.md`, `docs/services/access.md`.

Additional claimable paths: `services/main/src/modules/access/contexts.ts`; `services/main/src/modules/access/representations.ts`; `services/main/src/modules/access/*-schema.ts`; `tests/qa/integration/access-representation-api.test.ts`; `tests/qa/integration/access-grant-api.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/integration/access-representation-api.test.ts tests/qa/integration/access-grant-api.test.ts`.

Keep authority intent in the short identity page; move wire examples and state matrices into the already installed owner schemas. Serial with B09/B16 for overlapping Access claims.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/identity-and-access.md` | 883 | `shorten` | `services/main/src/modules/access/contexts.ts`, representations.ts, grants.ts, topology-schema.ts, policy-schema.ts; `services/account/src/auth.ts` | Target ≤80 lines: private principal/public Agent separation, independent organizations and reasons for typed representation; encode the extensive API/state matrices. |
| `docs/services/access.md` | 71 | `encode` | `services/main/src/modules/access/admission.ts`, contexts.ts, policy-evaluator.ts; `tests/qa/integration/access-policy-api.test.ts` | The in-process interface, outcomes and fail-closed behavior belong in types/tests; placement rationale survives in the short Access research and architecture pages. |

### B09 — Consolidate policy and authorization protocols

Document claims: `docs/implementation/access-control.md`, `docs/implementation/authorization-bridge.md`, `docs/contracts/realm-participation.md`.

Additional claimable paths: `services/main/src/modules/access/policy-*.ts`; `services/main/src/modules/access/org-realm-*.ts`; `services/main/src/modules/access/organization-*.ts`; `tests/qa/integration/access-policy*.test.ts`; `tests/qa/integration/access-org-realm*.test.ts`.

Checks: `task main:typecheck`, `task test -- services/main/tests/access-policy-evaluator.test.ts`, `task test -- tests/qa/integration/access-policy-api.test.ts tests/qa/integration/access-org-realm-api.test.ts`.

After B08; retain the short cross-store trust-boundary explanation. Large additional authority profiles are out of this documentation batch.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/implementation/access-control.md` | 359 | `encode` | `services/main/src/modules/access/policy-schema.ts`, policy-evaluator.ts, decision-snapshot-store.ts; `services/main/migrations/`; `tests/qa/integration/access-policy-api.test.ts` | Move coherent-frame and ordered-policy examples to tests and evaluator comments; retire the now-obsolete implementation sequence, keeping selection reasons in B02. |
| `docs/implementation/authorization-bridge.md` | 233 | `shorten` | `services/main/src/modules/access/admission.ts`; `services/main/src/modules/work/strong-revoke.ts`; `tests/qa/fault-recovery/sys-revocation.test.ts` | Target ≤45 lines: why Account, PostgreSQL admission and Jena commit are separate trust/transaction boundaries; put lease, fence and sealing details in code/tests. |
| `docs/contracts/realm-participation.md` | 410 | `encode` | `services/main/src/modules/access/org-realm-participation.ts`, managed-organizations.ts, organization-publication.ts; `tests/qa/integration/access-org-realm-api.test.ts` | Encode membership generations, independent/managed organizations and exact publication moderation in owner schemas and tests; remove route-by-route prose. |

### B10 — Replace package workflow blueprints

Document claims: `docs/contracts/package-management.md`, `docs/implementation/package-plans.md`, `docs/services/package-runtime.md`.

Additional claimable paths: `services/main/src/modules/package/lock*.ts`; `services/main/src/modules/package/install*.ts`; `tests/qa/integration/package-install*.test.ts`; `tests/qa/fault-recovery/package-install-process-crash.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/integration/package-install-api.test.ts tests/qa/integration/package-install-request.test.ts`, `task test -- tests/qa/fault-recovery/package-install-process-crash.test.ts`.

After B05/B06. The current Cargo solver is TypeScript in Main; do not preserve the prose claim that a selected Rust runtime already owns it.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/package-management.md` | 391 | `shorten` | `services/main/src/modules/package/lock-schema.ts`, install-schema.ts, cargo-solver.ts; `services/main/src/routes/packages.ts` | Target ≤40 lines: ecosystem-specific semantics and controlled-execution boundary; replace model/wire tables and stale solver prescriptions with actual types and tests. |
| `docs/implementation/package-plans.md` | 95 | `encode` | `services/main/src/modules/package/lock-schema.ts`, install-schema.ts, install.ts, install-hooks.ts; `tests/qa/fault-recovery/package-install-process-crash.test.ts` | Turn the fictional lock JSON and crash matrix into typed fixtures and journal transition tests, then delete this second specification. |
| `docs/services/package-runtime.md` | 37 | `encode` | `services/main/src/modules/package/install-request.ts`, install.ts, cargo-solver.ts; `services/main/src/routes/package-install-requests.ts` | Describe the actual execution boundary in module interfaces/comments; preserve future hostile-code hosting as a separate rollout decision, not a fictitious deployed service. |

### B11 — Encode rating and temporal contracts

Document claims: `docs/contracts/ratings.md`, `docs/contracts/event-time.md`, `docs/testing/ratings-and-event-time.md`.

Additional claimable paths: `services/main/src/modules/rating/**`; `services/main/src/modules/event/**`; `model/definitions/*rating*.ts`; `model/definitions/event-time-v1.ts`; `scripts/qa/cases/ratings.ts` (new); `services/main/tests/rating-*.test.ts`; `services/main/tests/event-time.test.ts`.

Checks: `task main:typecheck`, `task test -- services/main/tests/rating-aggregate.test.ts services/main/tests/rating-calendar.test.ts services/main/tests/event-time.test.ts`, `task test -- tests/qa/integration/event-time.test.ts tests/qa/integration/rating-global-synthesis.test.ts`.

After B00. If profile code changes, regenerate through the manager and run task gen:check; copying existing semantics into tests alone does not need a new profile.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/ratings.md` | 438 | `encode` | `model/definitions/*rating*.ts`; `services/main/src/modules/rating/`; `services/main/tests/rating-aggregate.test.ts`, rating-calendar.test.ts | Move standing/daily/experience slots, target grains, reduction formulas and population boundaries into profile descriptions, types and table-driven tests. |
| `docs/contracts/event-time.md` | 64 | `encode` | `model/definitions/event-time-v1.ts`; `services/main/src/modules/event/time.ts`, queries.ts; `tests/qa/integration/event-time.test.ts` | Encode exact/unknown/open endpoints, alias deduplication, unsupported calendars and query caps; distinguish static bounds from measured engine work. |
| `docs/testing/ratings-and-event-time.md` | 179 | `encode` | `scripts/qa/cases/ratings.ts` (new); `scripts/qa/coverage/rate*.ts`; `services/main/tests/rating-*.test.ts`; `tests/qa/fault-recovery/event-time.test.ts` | Preserve RATE01–09 scenarios and scope qualifications in the registry and owner tests; remove the duplicate formulas and run descriptions. |

### B12 — Reduce the QA manual to operating instructions

Document claims: `docs/testing/test-harness.md`, `docs/testing/complexity.md`.

Additional claimable paths: `scripts/qa/core.ts`; `scripts/qa/test.ts`; `scripts/qa/affected.ts`; `scripts/qa/replay.ts`; `scripts/load/measurement.ts`; `tests/qa/unit/core.test.ts`; `tests/qa/unit/affected.test.ts`; `tests/qa/unit/test-selector.test.ts`.

Checks: `task test -- tests/qa/unit/core.test.ts tests/qa/unit/affected.test.ts tests/qa/unit/test-selector.test.ts scripts/load/measurement.test.ts`.

After B00. Do not expand this batch into full performance instrumentation: preserve unobserved-cost gaps as explicit metadata and later work.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/testing/test-harness.md` | 677 | `shorten` | `scripts/qa/core.ts`, cli.ts, test.ts, affected.ts, replay.ts; `tests/qa/unit/` | Target ≤100 lines: select/run/replay a tier, isolation, diagnose artifacts and record qualification; schemas, tier lists and budgets become checked code/help. |
| `docs/testing/complexity.md` | 244 | `shorten` | `scripts/load/measurement.ts`; `services/main/src/modules/work/search-budget.ts`; `tests/qa/unit/search-route-budgets.test.ts`; owner cost-contract comments | Target ≤65 lines: derive/measure work and interpret unobserved counters; move operation-specific arithmetic beside code, retaining the deferred full-inventory/500M boundary. |

### B13 — Keep a concise recovery runbook

Document claims: `docs/operations/recovery.md`.

Additional claimable paths: `scripts/operations/search-state.ts`; `scripts/operations/rebuild-content-search.ts`; `scripts/dev/format-upgrade.ts`; `services/main/src/modules/work/*recovery*.ts`; `tests/qa/fault-recovery/recovery-coverage-discovery.test.ts`.

Checks: `task test -- scripts/operations/search-state.test.ts`, `task test -- tests/qa/fault-recovery/recovery-coverage-discovery.test.ts`.

Only run a restore drill if executable recovery changes; removing repeated examples does not require restoring a bulk fixture.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/operations/recovery.md` | 614 | `shorten` | `scripts/dev/commands.ts`; `scripts/operations/search-state.ts`, rebuild-content-search.ts; `services/main/src/modules/work/restore-lineage.ts`; owner recovery-coverage modules | Target ≤140 lines: choose a recovery cut, isolate restore, retain authority/erasure frontiers, rebuild text, prove readiness and reopen; encode long table inventories and shell recipes. |

### B14 — Replace storage and service implementation copies

Document claims: `docs/storage/jena.md`, `docs/storage/postgresql.md`, `docs/storage/objects.md`, `docs/storage/ownership-and-placement.md`, `docs/storage/schema-evolution.md`, `docs/architecture/services.md`, `docs/services/main.md`.

Additional claimable paths: `services/content/src/**`; `services/main/src/infrastructure/**`; `scripts/dev/release-manifest.ts`; `scripts/dev/format-upgrade.ts`; `tests/qa/unit/recovery-coverage.test.ts`; `services/content/tests/core.integration.test.ts`; `services/main/tests/immutable-objects.test.ts`.

Checks: `task content:typecheck`, `task main:typecheck`, `task test -- services/main/tests/immutable-objects.test.ts tests/qa/unit/recovery-coverage.test.ts`, `task test -- services/content/tests/core.integration.test.ts`.

Preserve startup topology and operational procedure in the shortened architecture/recovery pages. Narrow source claims to the actual comments/types/tests chosen in the brief.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/storage/jena.md` | 377 | `shorten` | `infra/jena/fuseki-text.ttl`; `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java`; `services/main/src/infrastructure/fuseki.ts` | Target ≤55 lines: one-JVM/private-store decision and operational transaction/history limitations; move exact command/validation contracts into Java and adapter tests. |
| `docs/storage/postgresql.md` | 123 | `encode` | `services/content/src/`; `services/content/migrations/`; `services/account/migrations/`; `services/main/migrations/`; `services/content/tests/core.integration.test.ts` | Schemas, publication pins, receipt transactions and owner-specific integrity belong in migrations, types and integration tests; deployment reasoning already has an owner. |
| `docs/storage/objects.md` | 65 | `encode` | `services/main/src/infrastructure/`; `services/main/src/modules/work/object-gc.ts`; `services/main/tests/immutable-objects.test.ts`; `tests/qa/fault-recovery/sys-work-object-orphan.test.ts` | Move digest, staging, retention and current-disclosure rules into object interfaces and recovery tests, preserving remote-S3 qualification limits. |
| `docs/storage/ownership-and-placement.md` | 129 | `shorten` | `services/main/src/modules/owner/schema.ts`; apphost/; `infra/dev/compose.yaml`; `tests/qa/fault-recovery/partition-relocation.test.ts` | Target ≤35 lines: why one writer per component and logical identity survives movement; replace placement/state inventories with topology and fencing types. |
| `docs/storage/schema-evolution.md` | 67 | `shorten` | `scripts/dev/release-manifest.ts`, format-upgrade.ts; `model/compiler/`; `tests/qa/fault-recovery/second-host-format-upgrade.test.ts` | Target ≤35 lines: upgrade/rollback operator sequence and reasons to version meaning separately; encode compatibility and irreversible-transition guards. |
| `docs/architecture/services.md` | 67 | `shorten` | `services/main/src/app.ts`; `services/account/src/app.ts`; `services/content/src/`; apphost/; .dependency-cruiser.json | Target ≤35 lines: reasons for separate Account and in-process Access/Content ownership; executable topology and import rules replace interface inventories. |
| `docs/services/main.md` | 111 | `encode` | `services/main/src/app.ts`; `services/main/src/routes/dependencies.ts`; `services/main/src/infrastructure/`; `tests/qa/integration/main-readiness.test.ts` | Move request/failure/framework details into app interfaces and readiness tests; keep deployment and ownership rationale in architecture pages. |

### B15 — Encode source conformance and rights records

Document claims: `docs/testing/source-conformance.md`, `docs/contracts/semantic-interoperability.md`, `docs/contracts/license-grants.md`, `docs/research/source-data-rights.md`.

Additional claimable paths: `scripts/qa/cases/sources.ts` (new); `services/main/src/modules/source/run-schema.ts`; `services/main/src/modules/rights/schema.ts`; `services/main/src/modules/export/**`; `tests/qa/integration/source-run-*.test.ts`; `tests/qa/integration/rights-*.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/integration/source-run-acquisition.test.ts tests/qa/integration/source-reification.test.ts tests/qa/integration/rights-use-assessment.test.ts`.

After B00/B07. Preserve policy rationale without turning legal conclusions into machine permission; no new external legal/provider research or live acquisition is necessary for this extraction.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/testing/source-conformance.md` | 431 | `encode` | `scripts/qa/cases/sources.ts` (new); `scripts/qa/coverage/live-*.ts`; `tests/qa/integration/source-run-acquisition.test.ts`, source-field.test.ts, rights-use-assessment.test.ts | Transfer LIVE01–18 and per-provider acquisition/coverage qualifications into fixtures and case metadata; incomplete rights metadata is not a blanket intake denial. |
| `docs/contracts/semantic-interoperability.md` | 59 | `encode` | `services/main/src/modules/source/reification.ts`; `services/main/src/modules/export/schema.ts`; `model/tests/source-reification.test.ts` | Use source/exchange schemas and round-trip counterexamples for blank nodes, exact values, qualifiers and residuals; then delete the generic specification. |
| `docs/contracts/license-grants.md` | 39 | `shorten` | `services/main/src/modules/rights/schema.ts`, offering.ts; `tests/qa/integration/rights-offering.test.ts` | Target ≤20 lines: a recorded instrument is neither Access authority nor legal clearance; encode offering uniqueness/history and link the use-specific legal rationale. |
| `docs/research/source-data-rights.md` | 116 | `keep` | `services/main/src/modules/rights/schema.ts` and use-assessment tests encode recorded basis, not legal judgments | Dated legal/provider evidence, reasons for use-specific intake and unresolved publication decisions cannot be replaced by schemas or passing tests. |

### B16 — Encode Account and Access acceptance

Document claims: `docs/testing/identity-and-access.md`, `docs/services/account.md`, `docs/contracts/connected-apps.md`, `docs/turnstile.md`.

Additional claimable paths: `scripts/qa/cases/identity.ts` (new); `scripts/qa/coverage/iam*.ts`; `services/account/src/auth.ts`; `services/account/src/consent-fence.ts`; `services/account/tests/**`; `tests/qa/integration/account-boundary-code-guard.test.ts`.

Checks: `task account:typecheck`, `task test -- services/account/tests/consent-revocation.integration.test.ts services/account/tests/oidc-authorization.integration.test.ts tests/qa/integration/account-boundary-code-guard.test.ts`.

After B00/B08/B09; retain uncovered provider/browser requirements explicitly. Turnstile adoption itself requires an Account feature brief if the implementation is absent.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/testing/identity-and-access.md` | 465 | `encode` | `scripts/qa/cases/identity.ts` (new); `scripts/qa/coverage/iam*.ts`; `services/account/tests/`; `tests/qa/integration/access-*.test.ts` | Move IAM case and subcase descriptions, coherent-snapshot races and denied/unknown outcomes into cases and existing owner tests; do not infer full coverage from a title prefix. |
| `docs/services/account.md` | 215 | `shorten` | `services/account/src/auth.ts`, installations.ts, signing-keys.ts, consent-fence.ts; `services/account/tests/` | Target ≤45 lines: private-account boundary and key/consent operational entry points; types and tests replace endpoint, lifecycle and signing-generation inventories. |
| `docs/contracts/connected-apps.md` | 115 | `encode` | `services/account/src/installations.ts`, consent-fence.ts, oauth-code-guard.ts; `services/main/src/modules/connected-apps/schema.ts`; `tests/qa/integration/connected-app-api.test.ts` | Encode exact redirect/PKCE, independent delegation ceilings and refresh/revocation races in schema and integration tests. |
| `docs/turnstile.md` | 17 | `encode` | `services/account/src/auth.ts`, config.ts; new Account challenge-admission contract tests | Make action/origin/replay and unavailable-provider outcomes explicit in Account admission tests; the page describes a prospective profile, not an installed Turnstile integration. |

### B17 — Encode commands, events and client synchronization

Document claims: `docs/implementation/api-and-events.md`, `docs/contracts/api.md`, `docs/contracts/commands.md`, `docs/contracts/events-and-jobs.md`, `docs/contracts/client-synchronization.md`, `docs/testing/backend-integration.md`, `docs/services/workers.md`.

Additional claimable paths: `services/main/src/routes/problems.ts`; `services/main/src/modules/outbox/**`; `services/main/src/modules/access/receipt-families.ts`; `scripts/api/generate.ts`; `scripts/qa/cases/system.ts` (new); `tests/qa/unit/outbox-event-handlers.test.ts`; `tests/qa/fault-recovery/lost-response.test.ts`.

Checks: `task main:typecheck`, `task test -- tests/qa/unit/outbox-event-handlers.test.ts services/main/tests/api-contract.test.ts`, `task test -- tests/qa/fault-recovery/lost-response.test.ts`, `task gen:check`.

After B00. New offline client behavior remains frontend-owned; retain unimplemented reconnect/merge requirements as explicit pending cases until a client delivery brief handles them.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/implementation/api-and-events.md` | 531 | `shorten` | `services/main/src/routes/`; `scripts/api/generate.ts`; `services/main/src/modules/access/receipt-families.ts`; `services/main/src/modules/outbox/` | Target ≤45 lines: procedure for adding an owner operation, receipt family, event handler and projection recipe; generated OpenAPI and tests replace copied wire examples. |
| `docs/contracts/api.md` | 80 | `encode` | `scripts/api/generate.ts`; `services/main/src/routes/problems.ts`; `services/main/tests/api-contract.test.ts`; `tests/qa/client/main-contract.ts` | Make envelopes, errors, pagination and client equivalence executable API-contract tests; do not retain a parallel handwritten wire specification. |
| `docs/contracts/commands.md` | 158 | `encode` | `services/main/src/infrastructure/fuseki.ts`; `services/content/src/`; `tests/qa/fault-recovery/lost-response.test.ts`; `scripts/qa/coverage/sys-receipts.ts` | Bind idempotency, CAS, exact publication and receipt-based reconciliation to owner types and failure tests; keep cross-store rationale in the short bridge note. |
| `docs/contracts/events-and-jobs.md` | 132 | `encode` | `services/main/src/modules/outbox/`; `services/main/src/relay.ts`; `tests/qa/integration/owner-outbox-recovery.test.ts`, owner-relay-gap.test.ts | Put event positions, gap recovery, leases and uncertain effects in event/worker interfaces and recovery tests. |
| `docs/contracts/client-synchronization.md` | 42 | `encode` | `apps/web/features/`; `services/main/src/modules/outbox/`; new offline/reconnect tests under `apps/web/tests/` | frontend-owned: encode queued-command identity, per-tab actor binding and conflict states in client types/stories/tests before deleting this prospective flow. |
| `docs/testing/backend-integration.md` | 41 | `encode` | `scripts/qa/cases/system.ts` (new); `scripts/qa/coverage/sys*.ts`; `tests/qa/fault-recovery/`; `tests/qa/integration/sys-receipt-relay-gap.test.ts` | Preserve SYS01–14 cross-owner recovery and idempotency scenarios in the typed inventory and actual fault tests. |
| `docs/services/workers.md` | 58 | `encode` | `services/main/src/relay.ts`; `services/main/src/modules/notification/delivery-worker.ts`; `services/main/src/modules/recommendation/build-worker.ts` | Worker intent, lease, backpressure and recovery interfaces/tests can state these rules; operational tuning remains in deployment/recovery instructions. |

### B18 — Make model definitions and validators the specification

Document claims: `docs/contracts/model-profiles.md`, `docs/contracts/semantic-model.md`, `docs/implementation/graph-records.md`, `docs/implementation/model-profile-validation.md`, `docs/contracts/standards.md`, `docs/testing/model-contracts.md`, `docs/contracts/system-invariants.md`.

Additional claimable paths: `model/compiler/**`; `model/definitions/**`; `model/tests/**`; `infra/jena/command-module/src/main/java/com/rezics/jena/ProfileRegistry.java`; `scripts/qa/cases/model.ts` (new); `tests/qa/unit/validation-guards.test.ts`.

Checks: `task model:typecheck`, `task test -- tests/qa/unit/validation-guards.test.ts`, `task test -- model/compiler/generate.test.ts model/tests/native-equivalence.test.ts`, `task gen:check`.

After B00. Do not copy all prose into comments: keep definition metadata, representative fixtures and explanations of non-obvious invariants. Coordinate profile changes with their owner batches; narrow claims at dispatch.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/model-profiles.md` | 194 | `shorten` | `model/compiler/ir.ts`, registry.ts; `model/definitions/`; `infra/jena/command-module/src/main/java/com/rezics/jena/ProfileRegistry.java` | Target ≤45 lines: why reuse standard vocabulary and separate shapes, pure rules and transactional commands; encode the remaining rule-allocation matrix. |
| `docs/contracts/semantic-model.md` | 204 | `encode` | `model/compiler/ir.ts`; `model/definitions/value-exact-v1.ts`; `services/main/src/modules/semantic/value.ts`; `services/main/tests/work-scalar-value.test.ts` | Represent reference grains, exact/missing scalar states and seven definition responsibilities in IR/types and lossless-value tests. |
| `docs/implementation/graph-records.md` | 265 | `encode` | `model/definitions/`; `model/compiler/outputs.ts`; `services/main/src/modules/work/history.ts`; `tests/qa/integration/context-statement-cases.test.ts` | Replace Turtle/query sketches and revision-resolution records with generated artifacts and executable fixtures; retain namespace rationale as a compiler comment. |
| `docs/implementation/model-profile-validation.md` | 329 | `shorten` | `model/compiler/generate.ts`; `infra/jena/command-module/src/main/java/com/rezics/jena/ProfileRegistry.java`; `tests/qa/integration/validation-command.test.ts` | Target ≤45 lines: add/activate a profile and inspect a rejected command; move validation closure, command registry and examples into compiler/native tests. |
| `docs/contracts/standards.md` | 62 | `encode` | `model/compiler/registry.ts`; `model/definitions/`; `model/tests/native-equivalence.test.ts`; `tests/qa/integration/model-standard-label.test.ts` | Pin admitted vocabularies/mappings and counterexamples in definition metadata and conformance tests, including each unsupported semantic inference. |
| `docs/testing/model-contracts.md` | 104 | `encode` | `scripts/qa/cases/model.ts` (new); `scripts/qa/coverage/model*.ts`; `model/tests/`; `tests/qa/integration/validation-*.test.ts` | Transfer MODEL scenarios and exact-versus-reference-validator scope into cases and compiler/native tests; old engine results do not qualify Jena. |
| `docs/contracts/system-invariants.md` | 59 | `encode` | `scripts/qa/cases/**` (new invariant references); `model/compiler/ir.ts`; `scripts/qa/coverage.ts`; owner transition tests | Retain stable I01–I14 references as typed case metadata and targeted invariants; do not replace behavioral proofs with an ID-presence test. |

### B19 — Encode shared Context and Statement semantics

Document claims: `docs/contracts/context.md`, `docs/contracts/classification.md`, `docs/contracts/classification-judgments.md`, `docs/testing/classification.md`, `docs/research/semantic-web-model-coverage.md`.

Additional claimable paths: `services/main/src/modules/context/**`; `services/main/src/modules/statement/**`; `services/main/src/modules/judgment/schema.ts`; `scripts/qa/cases/classification.ts` (new); `tests/qa/integration/context-*-cases.test.ts`.

Checks: `task main:typecheck`, `task test -- services/main/tests/context-schema.test.ts`, `task test -- tests/qa/integration/context-template.test.ts tests/qa/integration/context-statement-cases.test.ts tests/qa/integration/context-rule-cases.test.ts`.

After B00; serialize model-definition changes with B18. Preserve rejected mandatory Tag/Path/Sense design reasons, not its obsolete implementation-transition status.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/context.md` | 344 | `shorten` | `services/main/src/modules/context/schema.ts`, interpretation.ts; `model/definitions/context-v1.ts`; `tests/qa/integration/context-template.test.ts` | Target ≤50 lines: shared meaning versus acceptance/authority and why exact authored interpretation survives viewer changes; encode selection order and bounded resolution. |
| `docs/contracts/classification.md` | 240 | `shorten` | `model/definitions/statement-v1.ts`; `services/main/src/modules/statement/schema.ts`; `tests/qa/integration/context-statement-cases.test.ts` | Target ≤40 lines: why object/Statement identities replace mandatory wrapper chains; encode decision transitions, grouping and legacy compatibility in schemas/tests. |
| `docs/contracts/classification-judgments.md` | 79 | `encode` | `services/main/src/modules/judgment/schema.ts`; `tests/qa/unit/judgment-policy.test.ts`; `tests/qa/integration/judgment-api.test.ts` | Fit, spoiler, measurement and protection dimensions belong in discriminated types, formulas and population/correction tests. |
| `docs/testing/classification.md` | 113 | `encode` | `scripts/qa/cases/classification.ts` (new); `scripts/qa/coverage/ctx.ts`; `tests/qa/integration/context-*-cases.test.ts` | Move CTX01–10 and shared-Context subcases into the typed inventory and adversarial owner fixtures; retain original meanings during cutover. |
| `docs/research/semantic-web-model-coverage.md` | 248 | `shorten` | `model/definitions/`; `model/tests/native-equivalence.test.ts`; `services/main/src/modules/context/interpretation.ts` | Target ≤65 lines: accepted/rejected vocabulary equivalences and reasons, shared Context decision and spatial maturity limits; eliminate the duplicated domain inventory. |

### B20 — Encode Work, releases and authored content

Document claims: `docs/contracts/main-version.md`, `docs/contracts/work-and-release.md`, `docs/contracts/content-languages.md`, `docs/contracts/creation.md`, `docs/contracts/distribution.md`, `docs/contracts/metadata-only.md`, `docs/testing/native-work.md`, `docs/testing/book-and-creation.md`, `docs/implementation/vertical-workflows.md`.

Additional claimable paths: `services/main/src/modules/work/native-variants.ts`; `services/main/src/modules/work/fixed-release.ts`; `services/main/src/modules/work/translation-links.ts`; `services/main/src/modules/content-publication/**`; `scripts/qa/cases/work.ts` (new); `scripts/qa/cases/book.ts` (new).

Checks: `task main:typecheck`, `task test -- services/main/tests/translation-links.test.ts`, `task test -- tests/qa/integration/native-variants.test.ts tests/qa/integration/translated-work-links.test.ts tests/qa/integration/structure-book-content.test.ts`.

After B00. The root product page retains why one maintained Work entry matters; user-interface rendering and offline editing need the frontend owner.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/main-version.md` | 203 | `shorten` | `services/main/src/modules/work/select-main.ts`, select-realm.ts, native-variants.ts; `model/definitions/main-default-selection-v1.ts` | Target ≤35 lines: why maintained identity, external edition and adopted contribution differ; move publication/adoption state and API examples into owner tests. |
| `docs/contracts/work-and-release.md` | 224 | `encode` | `services/main/src/modules/work/fixed-release.ts`, derivations.ts, native-variants.ts; `model/definitions/fixed-native-text-release-v1.ts` | Use Work/release types, exact sealed fixtures and concurrency tests for all grain distinctions; product rationale survives in Main Version/product pages. |
| `docs/contracts/content-languages.md` | 89 | `encode` | `services/main/src/modules/work/translation-links.ts`, native-variants.ts; `tests/qa/integration/translated-work-links.test.ts` | Encode exact BCP47/missingness/selection behavior and language-link corrections in schemas/tests; content language must remain independent of UI locale. |
| `docs/contracts/creation.md` | 60 | `encode` | `services/main/src/modules/content-publication/`; `services/main/src/modules/structure/`; `tests/qa/integration/structure-book-content.test.ts` | Turn creation/adoption/export and nontext publication scenarios into owner tests; carry interaction intent into frontend stories rather than another API document. |
| `docs/contracts/distribution.md` | 29 | `encode` | `services/main/src/modules/work/fixed-release.ts`; `services/main/src/modules/media/`; `model/definitions/fixed-native-text-release-v1.ts` | Use release/representation/Media Use schemas and sealing tests to preserve provenance and repeated occurrences; unsupported external distributions remain explicit. |
| `docs/contracts/metadata-only.md` | 21 | `encode` | `services/main/src/modules/work/create-admitted.ts`, native-variants.ts; `tests/qa/integration/native-variants.test.ts`; new hosting-transition cases | Metadata-only creation exists; encode later hosting/disabling and SEO/history obligations before deleting the broader transition requirements. |
| `docs/testing/native-work.md` | 88 | `encode` | `scripts/qa/cases/work.ts` (new); `scripts/qa/coverage/work*.ts`; `tests/qa/integration/native-variants.test.ts`, work-derivation.test.ts | Preserve WORK cases and distinctions between native identity, releases and installation grain in executable metadata/tests. |
| `docs/testing/book-and-creation.md` | 21 | `encode` | `scripts/qa/cases/book.ts` (new); `scripts/qa/coverage/book-edit.ts`; `tests/qa/integration/structure-book-content.test.ts`; `apps/web/tests/` | Preserve BOOK01–10, exact anchors and offline/revoked replay; browser-only completion must remain separate from backend evidence. |
| `docs/implementation/vertical-workflows.md` | 123 | `encode` | `tests/qa/integration/context-template.test.ts`, content-search-private-native.test.ts, source-field.test.ts; `services/main/tests/content-publication.integration.test.ts` | Make cross-owner sequences named integration journeys with failure assertions; remove the second written ordering of implemented owner commands. |

### B21 — Encode structures, Spaces and collections

Document claims: `docs/contracts/composition.md`, `docs/contracts/structure-history.md`, `docs/contracts/space.md`, `docs/testing/content-composition.md`, `docs/testing/wiki-composition.md`.

Additional claimable paths: `services/main/src/modules/structure/**`; `services/main/src/modules/space/**`; `services/main/src/modules/zone/**`; `scripts/qa/cases/composition.ts` (new); `scripts/qa/cases/wiki.ts` (new).

Checks: `task main:typecheck`, `task test -- tests/qa/integration/structure-composition.test.ts tests/qa/integration/structure-stage.test.ts tests/qa/integration/zone-wiki.test.ts`.

After B00; shared definition edits serialize with B18, publication-test edits with B20.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/composition.md` | 54 | `encode` | `services/main/src/modules/structure/profiles.ts`, tree.ts, refresh.ts; `tests/qa/integration/structure-composition.test.ts` | Occurrence identity, explicit expansion, refresh conflicts and manifest completeness belong in profile types and executable fixtures. |
| `docs/contracts/structure-history.md` | 73 | `encode` | `services/main/src/modules/structure/stage.ts`, seal-read.ts, order-key.ts; `tests/qa/integration/structure-stage.test.ts`; `tests/qa/fault-recovery/tdb2-compact-history.test.ts` | Encode retained anchors, staged activation, stable ordering and no-recursive-overwrite behavior beside structure implementations. |
| `docs/contracts/space.md` | 111 | `encode` | `model/definitions/space-realm-v1.ts`, zone-capability-v1.ts; `services/main/src/modules/zone/configuration.ts`; `tests/qa/integration/zone-wiki.test.ts` | Use capability schemas and tests for independent Realm/Zone retirement, mounting, context defaults and shared budgets. |
| `docs/testing/content-composition.md` | 19 | `encode` | `scripts/qa/cases/composition.ts` (new); `scripts/qa/coverage/comp*.ts`; `tests/qa/integration/structure-stage.test.ts` | Transfer COMP01–08 including the 30-record projection cap, crash checkpoints and stale authority into case metadata and boundary tests. |
| `docs/testing/wiki-composition.md` | 17 | `encode` | `scripts/qa/cases/wiki.ts` (new); `scripts/qa/coverage/wiki.ts`; `tests/qa/integration/zone-wiki.test.ts`, wiki-realm-selection.test.ts | Transfer WIKI01–06 mounting, private-member and accepted-revision assertions without treating a mount as copied content. |

### B22 — Encode protection and information quality

Document claims: `docs/contracts/editorial-protection.md`, `docs/testing/editorial-protection.md`, `docs/contracts/information-verification.md`, `docs/testing/information-verification.md`, `docs/contracts/identity-correction.md`.

Additional claimable paths: `services/main/src/modules/protection/**`; `services/main/src/modules/correction/**`; `services/main/src/modules/verification/**`; `scripts/qa/cases/verification.ts` (new); `tests/qa/integration/protection-*.test.ts`; `tests/qa/integration/verification-invalidation.test.ts`.

Checks: `task main:typecheck`, `task test -- services/main/tests/protection-schema-field-control.test.ts`, `task test -- tests/qa/integration/protection-work-api.test.ts tests/qa/integration/protection-content-api.test.ts tests/qa/integration/verification-invalidation.test.ts`.

After B00/B07; any native-policy/profile edits need a narrowed additional claim and model tests. Calibration evidence is not interchangeable with a schema pass.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/editorial-protection.md` | 227 | `shorten` | `services/main/src/modules/protection/schema.ts`; `services/main/src/modules/correction/schema.ts`; `infra/jena/command-module/src/main/java/com/rezics/jena/ProtectionPolicy.java` | Target ≤35 lines: why editorial protection is independent of Access and remains target-local; encode record/state/authority tables in schemas and transaction tests. |
| `docs/testing/editorial-protection.md` | 59 | `encode` | `tests/qa/integration/protection-work-api.test.ts`, protection-content-api.test.ts, protection-receipts.test.ts; `scripts/qa/cases/**` (existing-ID subcases) | Transfer subcases under their existing IDs, including races and exact evidence; do not invent new top-level acceptance IDs merely to replace prose. |
| `docs/contracts/information-verification.md` | 213 | `shorten` | `services/main/src/modules/verification/schema.ts`, analysis.ts; `tests/qa/unit/fact-calibration.test.ts`; `tests/qa/fixtures/fact-calibration/` | Target ≤40 lines: why provenance, support, reliability and acceptance differ and campaign rollout limits; encode stale quality summaries and abstention in tests. |
| `docs/testing/information-verification.md` | 52 | `encode` | `scripts/qa/cases/verification.ts` (new); `scripts/qa/coverage/fact*.ts`; `tests/qa/unit/fact-calibration.test.ts`; `tests/qa/integration/verification-invalidation.test.ts` | Transfer FACT requirements, method applicability and calibration limits into cases, labeled fixtures and invalidation tests. |
| `docs/contracts/identity-correction.md` | 30 | `encode` | `services/main/src/modules/address/resolution.ts`; `services/main/src/modules/owner/schema.ts`; new identity merge/split cases under `tests/qa/integration/` | Bounded address merge exists; broader identity/split and authority-transfer requirements need explicit pending cases before removing this page. |

### B23 — Encode governance and voting

Document claims: `docs/contracts/content-governance.md`, `docs/contracts/governance-rules.md`, `docs/contracts/votes-and-references.md`, `docs/contracts/community-interactions.md`, `docs/contracts/subject-association-reading.md`, `docs/testing/governance-and-delivery.md`.

Additional claimable paths: `services/main/src/modules/governance/**`; `services/main/src/modules/vote/**`; `services/main/src/modules/proposal/**`; `services/main/src/modules/realm-reply/**`; `scripts/qa/cases/governance.ts` (new).

Checks: `task main:typecheck`, `task test -- services/main/tests/vote-schema-commands.test.ts`, `task test -- tests/qa/integration/governance-report.test.ts tests/qa/integration/poll-template.test.ts tests/qa/integration/proposal-execution.test.ts`.

After B00; coordinate Account scopes and Access representation edits with B16. General conversations and unselected liquid-delegation profiles must not be presented as delivered.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/content-governance.md` | 67 | `encode` | `services/main/src/modules/governance/schema.ts`, evidence.ts, effects.ts; `tests/qa/integration/governance-report.test.ts`, rights-complaint.test.ts | Use exact-evidence and decision state types/tests for moderation and appeals; legal process and human review instructions retain their operating owners. |
| `docs/contracts/governance-rules.md` | 115 | `encode` | `services/main/src/modules/governance/rules.ts`; `model/definitions/charter-revision-v1.ts`; `services/main/src/modules/proposal/schema.ts` | Encode exact rule/localization revisions, charters and approved-effect digests; UI authoring remains frontend-owned. |
| `docs/contracts/votes-and-references.md` | 127 | `encode` | `services/main/src/modules/vote/schema.ts`, commands.ts; `model/definitions/poll-allocation-v1.ts`; `tests/qa/integration/poll-template.test.ts` | Conserved weight, independent approvals, one-hop proxies and current authority belong in schemas and concurrent tally tests. |
| `docs/contracts/community-interactions.md` | 41 | `encode` | `services/main/src/modules/realm-reply/schema.ts`; `services/main/src/modules/vote/schema.ts`; new conversation/history cases under `scripts/qa/cases/` | Move reply/poll identity rules to tests; keep unimplemented conversation history/eligibility explicit instead of assuming notification delivery implements messaging. |
| `docs/contracts/subject-association-reading.md` | 38 | `encode` | `services/main/src/modules/relation/schema.ts`; `services/main/src/modules/statement/schema.ts`; `tests/qa/integration/relation-change.test.ts` | Role-correlated occurrences, exact evidence and spoiler-qualified disclosure belong in relation schemas and read tests. |
| `docs/testing/governance-and-delivery.md` | 46 | `encode` | `scripts/qa/cases/governance.ts` (new); `scripts/qa/coverage/gov-*.ts`; `tests/qa/integration/poll-template.test.ts`, rights-complaint.test.ts | Preserve GOV01–25 including delivery, entitlements, scoped restrictions and restoration; map subfamilies to their separate owner tests. |

### B24 — Encode delivery and commercial state machines

Document claims: `docs/contracts/notifications.md`, `docs/contracts/subscriptions.md`, `docs/contracts/realm-delivery.md`, `docs/contracts/quotas.md`, `docs/testing/subscriptions-and-pro.md`, `docs/email-delivery.md`.

Additional claimable paths: `services/main/src/modules/notification/**`; `services/main/src/modules/commerce/**`; `services/main/src/modules/quota/**`; `services/main/src/modules/pro-site/**`; `scripts/qa/cases/subscriptions.ts` (new).

Checks: `task main:typecheck`, `task test -- tests/qa/integration/notification-delivery.test.ts tests/qa/integration/subscription-api.test.ts tests/qa/integration/quota-reservation-api.test.ts tests/qa/integration/pro-site-query.test.ts`.

After B00/B23. Email provider/domain rollout is an operator decision, not satisfied by fake-delivery acceptance.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/notifications.md` | 37 | `encode` | `services/main/src/modules/notification/schema.ts`, dispatcher.ts, realtime.ts; `tests/qa/integration/notification-delivery.test.ts` | Intent/read/delivery identities, uncertain ACK reconciliation and current recipient eligibility are executable state-machine obligations. |
| `docs/contracts/subscriptions.md` | 39 | `encode` | `services/main/src/modules/commerce/schema.ts`; `tests/qa/integration/subscription-api.test.ts`; `tests/qa/support/fake-payment.ts` | Encode independent paid/gift grants, exact quotes, replacement groups and callback idempotency; preserve unselected commercial rollout in product scope. |
| `docs/contracts/realm-delivery.md` | 42 | `encode` | `services/main/src/modules/pro-site/schema.ts`; `services/main/src/modules/realm-reply/schema.ts`; `tests/qa/integration/pro-site-query.test.ts`, realm-reply-api.test.ts | Use fixed-site and reply-selection tests across API and later SSR/browser consumers; shared Context must not overwrite original speech. |
| `docs/contracts/quotas.md` | 28 | `encode` | `services/main/src/modules/quota/schema.ts`; `services/main/src/operations/bounds.ts`; `tests/qa/integration/quota-reservation-api.test.ts` | Reservation/settlement units, idempotency and shared request ceilings belong in quota types and last-capacity race tests. |
| `docs/testing/subscriptions-and-pro.md` | 19 | `encode` | `scripts/qa/cases/subscriptions.ts` (new); `scripts/qa/coverage/sub.ts`; `tests/qa/integration/subscription-api.test.ts`; `tests/qa/fault-recovery/subscription-realm-restore.test.ts` | Preserve SUB01–08 including independent benefits, sparse fixed sites and restore fences in cases and owner tests. |
| `docs/email-delivery.md` | 21 | `merge` | `docs/operations/deployment.md`; `services/main/src/modules/notification/http-provider.ts`; `services/account/src/auth.ts` | Fold provider/domain/secret rollout procedure into deployment (≤15 added lines); encode purpose separation, preferences and retries in Account/notification tests. |

### B25 — Encode query and recommendation descriptors

Document claims: `docs/contracts/queries.md`, `docs/contracts/relationship-graph.md`, `docs/contracts/recommendations.md`, `docs/testing/relationship-graph.md`, `docs/testing/recommendations.md`.

Additional claimable paths: `services/main/src/modules/graph-query/**`; `services/main/src/modules/graph-layout/**`; `services/main/src/modules/recommendation/**`; `scripts/qa/cases/graph.ts` (new); `scripts/qa/cases/recommendations.ts` (new).

Checks: `task main:typecheck`, `task test -- tests/qa/unit/graph-query.test.ts`, `task test -- tests/qa/integration/recommendation-generation.test.ts tests/qa/integration/recommendation-context.test.ts`.

After B00/B04/B19. Advanced filter editor preservation is frontend-owned and requires stories/client tests, separate from query compilation.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/queries.md` | 56 | `encode` | `services/main/src/modules/graph-query/schema.ts`; `services/main/src/modules/work/search-grouped.ts`; new filter round-trip tests in `apps/web/features/` | Encode sparse descriptors, same-occurrence predicates and fixed-scope intersection; frontend-owned advanced-editor preservation must precede retirement. |
| `docs/contracts/relationship-graph.md` | 50 | `encode` | `services/main/src/modules/graph-query/schema.ts`; `services/main/src/modules/graph-layout/schema.ts`; `tests/qa/unit/graph-query.test.ts` | Typed relation roles, bounded frontier/completeness and independent layout state belong in query schemas and private-intermediate-node tests. |
| `docs/contracts/recommendations.md` | 34 | `encode` | `services/main/src/modules/recommendation/derived-generation.ts`, ranking-schema.ts, semantic-basis.ts; `tests/qa/integration/recommendation-context.test.ts` | Put signal populations, semantic/preference separation, generation activation and disclosure-qualified fallback in schemas and tests. |
| `docs/testing/relationship-graph.md` | 37 | `encode` | `scripts/qa/cases/graph.ts` (new); `scripts/qa/coverage/graph.ts`; `tests/qa/unit/graph-query.test.ts`; `tests/qa/integration/relation-change.test.ts` | Transfer GRAPH01–06 and graph/text correlation, private paths and layout-independence scenarios into executable cases. |
| `docs/testing/recommendations.md` | 24 | `encode` | `scripts/qa/cases/recommendations.ts` (new); `scripts/qa/coverage/rec*.ts`; `tests/qa/integration/recommendation-generation.test.ts`; `tests/qa/load/recommendation-skew.test.ts` | Transfer REC01–06, preserving skew/load evidence as a different tier from schema and generation-correctness checks. |

### B26 — Encode catalog, recipe and Hub domain contracts

Document claims: `docs/contracts/catalog.md`, `docs/contracts/recipes.md`, `docs/contracts/skills-and-prompts.md`, `docs/testing/recipes.md`, `docs/testing/ai-hub.md`, `docs/research/ai-hub-execution.md`, `docs/contracts/spatial-annotations.md`.

Additional claimable paths: `services/main/src/modules/catalog/**`; `services/main/src/modules/recipe/**`; `services/main/src/modules/hub/**`; `scripts/qa/cases/recipes.ts` (new); `scripts/qa/cases/hub.ts` (new).

Checks: `task main:typecheck`, `task test -- tests/qa/unit/recipe-importer.test.ts tests/qa/unit/recipe-export.test.ts tests/qa/unit/hub-deps.test.ts`, `task test -- tests/qa/integration/catalog-descriptions.test.ts tests/qa/integration/recipe-structure.test.ts tests/qa/integration/hub-api.test.ts`.

After B00/B05/B20. Spatial/world clients and persistent untrusted hosting remain explicitly deferred; no runtime activation is implied by an audit verdict.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/catalog.md` | 101 | `encode` | `services/main/src/modules/catalog/commands.ts`; `services/main/src/modules/work/native-variants.ts`; `tests/qa/integration/catalog-descriptions.test.ts` | Move provider-independent grain and organization-description examples to types and source/native fixtures; domain intent stays in product capabilities. |
| `docs/contracts/recipes.md` | 33 | `encode` | `model/definitions/recipe-structure-v1.ts`; `services/main/src/modules/recipe/quantity.ts`, importer.ts, export.ts; `tests/qa/integration/recipe-structure.test.ts` | Exact quantities, repeated ingredients, grouped steps and residuals are profile and round-trip-test content. |
| `docs/contracts/skills-and-prompts.md` | 68 | `encode` | `services/main/src/modules/hub/schema.ts`; `model/definitions/hub-item-v1.ts`; `tests/qa/integration/hub-api.test.ts`, hub-deps-api.test.ts | Encode file manifests, Prompt parameters, requirement sidecars and non-executing ingestion in schemas/fixtures. |
| `docs/testing/recipes.md` | 17 | `encode` | `scripts/qa/cases/recipes.ts` (new); `scripts/qa/coverage/recipe.ts`; `tests/qa/integration/recipe-*.test.ts` | Transfer RECIPE01–06 exactness, alternatives, yield coverage and independent support to code-owned cases. |
| `docs/testing/ai-hub.md` | 17 | `encode` | `scripts/qa/cases/hub.ts` (new); `scripts/qa/coverage/hub*.ts`; `tests/qa/integration/hub-api.test.ts`, connected-app-api.test.ts | Transfer HUB01–06 and malicious content/schema-drift/cancellation scenarios into code-owned cases. |
| `docs/research/ai-hub-execution.md` | 22 | `keep` | `services/main/src/modules/package/install-hooks.ts`; future executor capability profiles | Retain the unresolved hostile-execution and persistent-hosting admission decision; installed controlled hooks do not settle sandbox selection. |
| `docs/contracts/spatial-annotations.md` | 58 | `shorten` | `model/definitions/` (future spatial profile); future world/CRS conformance fixtures | Target ≤25 lines: deferred product intent, world-instance continuity and activation questions; move concrete coordinate/selector rules to code when the spatial owner exists. |

### B27 — Move workload numbers and derivations beside owners

Document claims: `docs/storage/workload-budgets.md`, `docs/storage/workloads/catalog-editorial-capacity.md`, `docs/storage/workloads/governance-delivery-capacity.md`, `docs/storage/workloads/identity-access-capacity.md`, `docs/storage/workloads/semantic-interoperability-capacity.md`, `docs/storage/workloads/statement-capacity.md`, `docs/storage/workloads/subscriptions-capacity.md`, `docs/storage/workloads/temporal-capacity.md`.

Additional claimable paths: `scripts/load/budget.ts`; `scripts/load/measurement.ts`; `scripts/fixture/manifest.ts`; `scripts/qa/cases/**` (new in B00); `services/main/src/operations/bounds.ts`; `tests/qa/unit/load-profile.test.ts`; `tests/qa/unit/fixture-manifest.test.ts`.

Checks: `task test -- tests/qa/unit/load-profile.test.ts tests/qa/unit/fixture-manifest.test.ts scripts/load/measurement.test.ts`.

After B00/B12 and corresponding owner batches. Convert derivations and dimensions only; full native-work instrumentation and 500M capacity remain later work. Do not build a new corpus or rerun load solely to remove prose.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/storage/workload-budgets.md` | 585 | `shorten` | `scripts/load/budget.ts`, measurement.ts; `scripts/fixture/`; `services/main/src/operations/bounds.ts`; `tests/qa/load/` | Target ≤90 lines: 500M/future-3B planning meaning, under-600-second preparation procedure and qualification limits; move numbers, equations and executed-run narratives into code/artifacts. |
| `docs/storage/workloads/catalog-editorial-capacity.md` | 25 | `encode` | `services/main/src/modules/source/field-application.ts`; `tests/qa/integration/source-field-cost.test.ts`; new source load dimensions | Encode names/support/child skew dimensions and declared work counters in source fixtures/cost metadata; leave unmeasured capacity explicit. |
| `docs/storage/workloads/governance-delivery-capacity.md` | 43 | `encode` | `services/main/src/modules/vote/commands.ts`; `services/main/src/modules/notification/delivery-worker.ts`; new governance workload fixtures | Represent seat contention, conservation, fan-out and retry budgets as typed workload parameters and operation cost assertions. |
| `docs/storage/workloads/identity-access-capacity.md` | 64 | `encode` | `services/main/src/modules/access/representations.ts`, topology.ts; `tests/qa/integration/access-topology-api.test.ts`; new Access workload dimensions | Separate representation/group/resource depth and reached work in fixture types; static ceilings and a 99% goal are not measured capacity. |
| `docs/storage/workloads/semantic-interoperability-capacity.md` | 25 | `encode` | `services/main/src/modules/source/acquisition-run.ts`; `services/main/src/modules/export/schema.ts`; new source/export workload fixtures | Encode source-fact amplification, stream overlap and export/rebuild dimensions; keep global planning assumptions in one workload page. |
| `docs/storage/workloads/statement-capacity.md` | 66 | `encode` | `services/main/src/modules/context/interpretation.ts`; `services/main/src/modules/work/search-grouped.ts`; `tests/qa/integration/growth-search-context.test.ts` | Use shared-Context, repeated-support and correlated-occurrence growth fixtures; record currently unobserved physical work instead of copying prose as a claimed pass. |
| `docs/storage/workloads/subscriptions-capacity.md` | 25 | `encode` | `services/main/src/modules/commerce/schema.ts`; `services/main/src/modules/quota/schema.ts`; new subscription workload fixtures | Put grant overlap, reservations, callbacks and publication-candidate dimensions in typed workload inputs and bounded-owner tests. |
| `docs/storage/workloads/temporal-capacity.md` | 25 | `encode` | `services/main/src/modules/event/queries.ts`; `services/main/src/modules/rating/`; `services/main/tests/event-time.test.ts`; new temporal growth fixtures | Encode slot churn, interval density and histogram dimensions; preserve the gap between current structural limits and measured scale. |

### B28 — Reduce operational prose and move the runnable assembler

Document claims: `docs/operations/installation.md`, `docs/operations/deployment.md`, `docs/operations/erasure.md`, `docs/operations/observability.md`, `docs/operations/security.md`, `docs/contracts/platform-lifecycle.md`, `docs/testing/operations.md`, `docs/operations/examples/fuseki-text.ttl`.

Additional claimable paths: `scripts/dev/release-manifest.ts`; `scripts/dev/commands.ts`; `scripts/operations/**`; `infra/jena/fuseki-text-qa-raw.ttl`; `services/main/tests/*integration.test.ts`; `services/main/tests/search-private.test.ts`; `services/account/tests/account-access-recovery.integration.test.ts`; `tests/qa/fault-recovery/search-ops-quickstart.test.ts`; `scripts/qa/cases/operations.ts` (new).

Checks: `task test -- services/main/tests/search-private.test.ts`, `task test -- tests/qa/fault-recovery/search-ops-quickstart.test.ts`, `task docs:check`.

After B00/B13/B14/B24. The TTL file is executable input to live and legacy tests, not disposable prose. Move/reuse it under infra only after comparing raw-update behavior and rewriting every consumer. No automatic full recovery or physical-destruction campaign is assigned here.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/operations/installation.md` | 384 | `shorten` | Taskfile.yml; `scripts/dev/install.ts`, commands.ts; `tests/qa/fault-recovery/search-ops-quickstart.test.ts` | Target ≤100 lines: prerequisites, task-based startup/readiness, worktree mode and cleanup; tests own the long S0 shell/SPARQL recipe and release validation. |
| `docs/operations/deployment.md` | 185 | `shorten` | apphost/; `infra/dev/compose.yaml`; `scripts/dev/release-manifest.ts`; `tests/qa/fault-recovery/second-host-format-upgrade.test.ts` | Target ≤75 lines including merged email setup: chosen topology, capacity assumptions, manual host/upgrade procedure and actual failure model. |
| `docs/operations/erasure.md` | 116 | `shorten` | `services/main/src/modules/erasure/schema.ts`; `infra/jena/command-module/src/main/java/com/rezics/jena/ErasurePurge.java`; `tests/qa/fault-recovery/erasure-restore.test.ts` | Target ≤55 lines: operator sequencing, hold/retention decisions and separate suppression/destruction evidence; code owns inventory/replay checks, production OPS10 remains deferred. |
| `docs/operations/observability.md` | 63 | `shorten` | `services/main/src/routes/health.ts`; `services/main/src/operations/`; `scripts/dev/commands.ts` | Target ≤30 lines: choose signals/artifacts and diagnose an uncertain outcome; encode readiness distinctions and redaction in health/log tests. |
| `docs/operations/security.md` | 78 | `shorten` | `infra/jena/fuseki-text.ttl`; `services/main/src/modules/access/`; `tests/qa/integration/account-boundary-code-guard.test.ts` | Target ≤30 lines: trust boundaries and operator response; put authentication, named-graph non-authority and disclosure checks in integration/lint rules. |
| `docs/contracts/platform-lifecycle.md` | 37 | `encode` | `scripts/dev/install.ts`; `services/main/src/modules/owner/schema.ts`; `services/main/src/modules/erasure/schema.ts`; `tests/qa/integration/owner-operations.test.ts` | Encode reserved identities, lifecycle/readiness outcomes and erasure replay fences in bootstrap and owner transition tests. |
| `docs/testing/operations.md` | 33 | `encode` | `scripts/qa/cases/operations.ts` (new); `scripts/qa/coverage/ops-*.ts`; `tests/qa/fault-recovery/`; `tests/qa/load/` | Transfer OPS01–16 while retaining fixture-versus-production erasure and measured-versus-derived performance scope; keep operator steps in runbooks. |
| `docs/operations/examples/fuseki-text.ttl` | 47 | `merge` | `infra/jena/fuseki-text-qa-raw.ttl` or a dedicated `infra/jena` quickstart fixture; `tests/qa/fault-recovery/search-ops-quickstart.test.ts` | Executable companion (47 lines), not a Markdown page: relocate the raw-update/CJK assembler and all runtime path consumers; never substitute the guarded product assembler blindly. |

### B29 — Frontend foundations: tokens, imports and review procedure

Document claims: `docs/development/design-system.md`, `docs/development/web-features.md`, `docs/development/storybook.md`.

Additional claimable paths: `packages/ui/src/styles.css`; `packages/ui/src/**/*.stories.tsx` (new); `apps/web/.storybook/**`; `apps/web/vitest.config.ts`; .dependency-cruiser.json; `scripts/static/**`.

Checks: `task ui:typecheck`, `task web:typecheck`, `task storybook:test -- <changed story files>`, `task docs:check`.

frontend-owned. The frontend Goal selects the design. This is a replacement destination, not approval of every current token/layout prescription. Any visible change also needs actual Storybook screenshots and the changed flow in a real browser.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/development/design-system.md` | 124 | `shorten` | `packages/ui/src/styles.css`; `packages/ui/src/components/`; `packages/ui/src/**/*.stories.tsx` (new); `packages/ui/THIRD_PARTY_NOTICES.md` | frontend-owned; target ≤25 lines: fork provenance and design intent; tokens, radii, elevation and layout examples become CSS and reviewed stories, retaining attribution. |
| `docs/development/web-features.md` | 40 | `encode` | `apps/web/features/`; `apps/web/tests/auth-boundaries.test.ts`; .dependency-cruiser.json; new import/query-key tests | frontend-owned: enforce API/BFF/token and import boundaries in lint/tests; preserve feature grouping and advanced state through typed adapters and stories. |
| `docs/development/storybook.md` | 32 | `shorten` | `apps/web/.storybook/`; `apps/web/vitest.config.ts`; `.agents/skills/storybook-ui-review/SKILL.md` | frontend-owned; target ≤20 lines: start/find Storybook, run scoped stories and inspect screenshots; remove duplicated configuration and reconcile stale permission wording with the active Goal. |

### B30 — Frontend journeys and product intent

Document claims: `docs/plan/frontend.md`, `docs/experience/identity-and-access-experience.md`, `docs/experience/filter-feed-and-zone-experience.md`, `docs/experience/studio-workspace-and-contributions.md`, `docs/experience/realm-rule-localization-authoring.md`, `docs/product/design-principles.md`, `docs/product/capabilities.md`.

Additional claimable paths: `apps/web/features/**/*.stories.tsx`; `apps/web/tests/**`; `apps/web/i18n/**`; `packages/ui/src/**/*.stories.tsx` (new).

Checks: `task web:typecheck`, `task storybook:test -- <changed story files>`, `task web:e2e -- <changed journey files>`.

frontend-owned. At most one journey is implemented per feature brief; this audit batch can transfer existing scenarios and leave unmet ones explicitly pending. A pending case or screenshot of a static story is not a completed browser journey.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/plan/frontend.md` | 46 | `shorten` | `apps/web/tests/`; `apps/web/features/**/*.stories.tsx`; GOAL.md | frontend-owned; target ≤20 lines: current product outcome and unresolved choices; code-owned stories/tests carry acceptance, and earlier design is not frozen by this audit. |
| `docs/experience/identity-and-access-experience.md` | 60 | `encode` | `apps/web/features/`; `apps/web/tests/auth-boundaries.test.ts`; new Account/acting-context stories and browser tests | frontend-owned: encode per-tab actor choice, administration, consent and recovery states in concrete flows before deleting their acceptance narrative. |
| `docs/experience/filter-feed-and-zone-experience.md` | 30 | `encode` | `apps/web/features/`; `apps/web/tests/public-search.e2e.ts`; new fixed-Realm/filter stories | frontend-owned: stories and browser tests carry common entry, language/context disclosure, advanced query preservation and sparse-site results. |
| `docs/experience/studio-workspace-and-contributions.md` | 35 | `encode` | `apps/web/features/work/`; new Studio contribution/conflict stories and browser tests | frontend-owned: implement selected-Agent drafts, exact review/adoption and recoverable conflicts through owner APIs, then retire the flow document. |
| `docs/experience/realm-rule-localization-authoring.md` | 21 | `encode` | `apps/web/i18n/`; new rule-revision/localization stories; `services/main/src/modules/governance/rules.ts` | frontend-owned: typed fixtures/stories must distinguish approved semantics from translation status, fallback and locale-only changes. |
| `docs/product/design-principles.md` | 107 | `shorten` | `apps/web/features/**/*.stories.tsx`; `.agents/skills/api-ui-design/SKILL.md`; `.agents/skills/external-content-value/SKILL.md` | frontend-owned; target ≤40 lines: task-first product intent and reasons to preserve meaning/material consequences; encode concrete defaults and examples with their features. |
| `docs/product/capabilities.md` | 55 | `shorten` | GOAL.md; `scripts/qa/cases/**` (new capability references); `apps/web/tests/` | Target ≤35 lines: native product purpose, M01–M10 scope and deferred rollouts; executable coverage replaces repeated contract/testing navigation. |

### B31 — Frontend media and resource presentation

Document claims: `docs/contracts/media.md`, `docs/contracts/presentation.md`.

Additional claimable paths: `services/main/src/modules/media/**`; `services/main/src/routes/resources.ts`; `apps/web/features/**/*.stories.tsx`; `packages/ui/src/components/avatar.tsx`; `apps/web/tests/**`.

Checks: `task main:typecheck`, `task web:typecheck`, `task ui:typecheck`, `task test -- tests/qa/integration/resource-summary.test.ts tests/qa/integration/media-api.test.ts`, `task storybook:test -- <changed media stories>`.

frontend-owned with Media API ownership. The 2026-09-27 emoji/icon avatar, ratio-keyed cover/banner and Post preview additions are expressly prospective. First extraction can record typed pending cases; implementing each missing API/flow is its own brief, and the document stays until that residual is covered.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/media.md` | 268 | `shorten` | `services/main/src/modules/media/summary.ts`, commands.ts; `tests/qa/integration/media-api.test.ts`; new visual-selection schemas/stories | frontend-owned; target ≤35 lines: why asset/use/presentation identities differ and reasons for chosen visual policies; move crop/ratio/preview hypotheses into reviewed API fixtures and stories. |
| `docs/contracts/presentation.md` | 158 | `encode` | `services/main/src/routes/resources.ts`; `services/main/src/modules/media/summary.ts`; `apps/web/features/**/*.stories.tsx`; new historical-Block rendering tests | frontend-owned: encode ResourceSummary, unknown-Block handling, shared budgets and media layout states; the proposed feed-height formula requires browser validation, not blind transcription. |

### B32 — Addressing, SEO and executable-theme boundaries

Document claims: `docs/contracts/addressing.md`, `docs/contracts/seo.md`, `docs/contracts/custom-theme-execution.md`, `docs/testing/presentation-and-addressing.md`, `docs/operations/custom-theme-external-live-access.md`, `docs/operations/custom-theme-review-and-incident-response.md`.

Additional claimable paths: `services/main/src/modules/address/**`; `services/main/src/modules/theme/**`; `apps/web/app/**`; `apps/web/tests/**`; `scripts/qa/cases/presentation.ts` (new).

Checks: `task main:typecheck`, `task web:typecheck`, `task test -- tests/qa/integration/work-address-api.test.ts tests/qa/integration/theme-activation-api.test.ts`, `task web:e2e -- <changed address/SEO journeys>`.

After B00; frontend-owned for rendering/SEO. Theme approval API tests do not qualify a hostile executable-theme sandbox or incident kill implementation.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/contracts/addressing.md` | 145 | `encode` | `services/main/src/modules/address/resolution.ts`; `model/definitions/work-address-claim-v1.ts`; `tests/qa/integration/work-address-api.test.ts` | Encode normalized claims, bounded rename/merge chains and exact references; frontend-owned route/SSR behavior must use the same resolution contract. |
| `docs/contracts/seo.md` | 24 | `encode` | `apps/web/app/`; `services/main/src/routes/resources.ts`; new metadata/sitemap privacy and invalidation tests | frontend-owned: canonical metadata, current disclosure, actual language and bounded sitemap work need executable projection/browser tests before this page goes. |
| `docs/contracts/custom-theme-execution.md` | 45 | `shorten` | `services/main/src/modules/theme/activation.ts`; `model/definitions/theme-activation-v1.ts`; `tests/qa/integration/theme-activation-api.test.ts` | Target ≤20 lines: why executable themes require separate admission and isolation; code owns approval CAS/expiry, while unimplemented execution/kill behavior remains explicit. |
| `docs/testing/presentation-and-addressing.md` | 93 | `encode` | `scripts/qa/cases/presentation.ts` (new); `scripts/qa/coverage/view*.ts`; `tests/qa/integration/resource-summary.test.ts`; `apps/web/tests/` | frontend-owned: preserve VIEW01–09, VIEW04 backend exclusion and new visual-selection subcases; never count the prospective media extension as existing backend evidence. |
| `docs/operations/custom-theme-external-live-access.md` | 15 | `merge` | `docs/operations/custom-theme-review-and-incident-response.md`; `services/main/src/modules/theme/activation.ts` | Merge grant/revoke operational steps into one theme review/incident runbook; code/test exact approval eligibility separately. |
| `docs/operations/custom-theme-review-and-incident-response.md` | 14 | `keep` | `services/main/src/modules/theme/activation.ts`; eventual executor kill/invalidation interfaces | Human artifact review, incident diagnosis and restoration decisions stay as one short runbook (≤30 lines after the merge), with unsupported rollout steps identified. |

### B33 — Keep only useful developer entry points

Document claims: `README.md`, `AGENTS.md`, `docs/development/README.md`, `docs/development/external-sources.md`, `docs/development/local-web-auth.md`.

Additional claimable paths: `scripts/dev/web-auth-bootstrap.ts`; `scripts/dev/web-auth-bootstrap.test.ts`; `scripts/documentation/**`.

Checks: `task docs:check`, `task test -- scripts/dev/web-auth-bootstrap.test.ts`.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `README.md` | 72 | `shorten` | Taskfile.yml; `scripts/dev/commands.ts`; `docs/operations/installation.md` | Target ≤40 lines: product purpose, prerequisites, task dev/urls/stop and links to current evidence; remove obsolete Content/P0.8 and uncovered-backend claims. |
| `AGENTS.md` | 33 | `keep` | Taskfile.yml; `scripts/qa/test.ts`; `docs/goals/worker.md` | Already a compact entry point for working procedure, maintainer authority and intent; executable tools complement rather than replace those instructions. |
| `docs/development/README.md` | 54 | `shorten` | Taskfile.yml; `scripts/documentation/check_docs.py`, test_check_docs.py; `scripts/qa/test.ts` | Target ≤30 lines: find owners, run targeted checks and inspect artifacts; remove bootstrap-status claims and use task docs:check instead of copied Python commands. |
| `docs/development/external-sources.md` | 72 | `shorten` | Version pins in package.json and infra/; source references beside owner profiles/tests | Target ≤35 lines: primary-source discovery and version-selection procedure; remove copied source/date inventories once their relevant owners carry them. |
| `docs/development/local-web-auth.md` | 75 | `shorten` | `scripts/dev/web-auth-bootstrap.ts`; `scripts/dev/web-auth-bootstrap.test.ts`; `tests/qa/integration/web-auth-bootstrap.test.ts` | Target ≤35 lines: create/use/clean the disposable PKCE fixture and diagnose it; code owns client registration, seeded permissions and secret handling. |

### B34 — Reduce Goal instructions without losing authority

Document claims: `docs/goals/README.md`, `docs/goals/manager.md`, `docs/goals/worker.md`, `docs/plan/execution-workflow.md`.

Additional claimable paths: `scripts/goal/goalctl.ts`; `scripts/goal/goalctl.test.ts`.

Checks: `task docs:check`, `task test -- scripts/goal/goalctl.test.ts`.

Manager-owned process changes: preserve standing directions and the active worker/manager entry paths. Reconcile the QA-slot wrapper writing the common checkout with workers restricted to their worktree; a read-only affected-plan preview need not acquire a shared slot.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/goals/README.md` | 151 | `shorten` | `scripts/goal/goalctl.ts`; `scripts/goal/goalctl.test.ts` | Target ≤90 lines: dispatch/resume/integrate/recover procedure and host lessons; code/help owns commands, engine choices, claim validation and usage thresholds. |
| `docs/goals/manager.md` | 194 | `shorten` | `scripts/goal/goalctl.ts`; GOAL.md | Target ≤120 lines: authority, standing maintainer directions, budget intent and startup/recovery; remove transient usage snapshots and duplicated command/engine tables. |
| `docs/goals/worker.md` | 172 | `shorten` | `scripts/goal/goalctl.ts`; .temp/goal/brief.md runtime input; owner test/extension mechanisms | Target ≤100 lines: scope, work order, verification and exact handoff; code enforces claims, and owner-local comments replace repeated backend schema recipes. |
| `docs/plan/execution-workflow.md` | 228 | `merge` | `docs/goals/README.md`; `docs/goals/worker.md`; `docs/testing/test-harness.md` | Fold unique batch/review/recovery procedure into its active owners within their target lengths; archive dated efficiency observations instead of retaining a fourth protocol. |

### B35 — Retain concise architecture and tooling reasons

Document claims: `docs/architecture/overview.md`, `docs/architecture/evidence.md`, `docs/research/application-stack.md`, `docs/research/access-and-interaction-placement.md`, `docs/implementation/interactions-and-cache.md`, `docs/research/toolchain-survey.md`, `docs/research/agent-efficiency-tooling.md`.

Checks: `task docs:check`.

This is decision-record editing, not a fresh external technology comparison. Preserve dated evidence and rejected alternatives with their actual limitations.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/architecture/overview.md` | 185 | `shorten` | apphost/; `infra/dev/compose.yaml`; `services/main/src/app.ts`; `services/content/src/` | Target ≤60 lines: selected owners, topology, history/search boundary and reasons; remove obsolete first-journey and implementation-status narration. |
| `docs/architecture/evidence.md` | 82 | `shorten` | `infra/jena/command-module/`; `scripts/research/storage_architecture/`; `model/tests/` | Target ≤40 lines: primary basis for non-obvious decisions and evidence that cannot transfer; runtime acceptance comes from recorded artifacts. |
| `docs/research/application-stack.md` | 178 | `shorten` | package.json; `apps/web/package.json`; `services/main/src/app.ts`; `scripts/research/http_framework_comparison/` | Target ≤60 lines: reasons for TypeScript/Bun/Elysia/vinext and rejecting a rewrite, with bounded comparison evidence; versions/interfaces belong in manifests/tests. |
| `docs/research/access-and-interaction-placement.md` | 79 | `merge` | `docs/research/access-storage-and-policy.md`; `docs/implementation/interactions-and-cache.md` | Fold the few distinct placement/cache reasons into the already shortened owners; remove another Access recommendation and stale pending-status list. |
| `docs/implementation/interactions-and-cache.md` | 281 | `shorten` | `services/main/src/modules/access/interaction-decisions.ts`; future durable-like/favorite owner tests and profiles | Target ≤35 lines: Jena ownership/Redis deferral rationale and actual activation gaps; Access blocking code is not proof that the proposed durable-like/favorite commands exist. |
| `docs/research/toolchain-survey.md` | 369 | `shorten` | package.json; `scripts/research/`; `docs/development/toolchain.md` generated inventory (B03) | Target ≤50 lines: rejected/deferred tools and reasons still affecting choices; delete the duplicated ecosystem catalog, pins and superseded adoption advice. |
| `docs/research/agent-efficiency-tooling.md` | 91 | `shorten` | Taskfile.yml; `scripts/qa/affected.ts`; `scripts/static/`; `scripts/goal/goalctl.ts` | Target ≤35 lines: adoption/rejection reasons and absence of measured savings; executable tooling owns command behavior and thresholds. |

### B36 — Retain deliberate deferred acquisition choices

Document claims: `docs/plan/low-priority/README.md`, `docs/plan/low-priority/curseforge-acquisition.md`, `docs/plan/low-priority/steam-workshop-acquisition.md`.

Checks: `task docs:check`.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/plan/low-priority/README.md` | 11 | `keep` | `tests/live/mod-public-provider.test.ts`; existing deferred-item pages | The small index records which acquisition decisions are intentionally deferred, independent of the qualified authored relation-model cases. |
| `docs/plan/low-priority/curseforge-acquisition.md` | 39 | `keep` | `tests/qa/fixtures/mod-provider-authored.ts`; `tests/live/mod-public-provider.test.ts` | Keep access/retention uncertainty and the maintainer deferral; authored PKG09 data does not establish API acquisition permission or coverage. |
| `docs/plan/low-priority/steam-workshop-acquisition.md` | 37 | `keep` | `tests/qa/fixtures/mod-provider-authored.ts`; `tests/live/mod-public-provider.test.ts` | Keep the unresolved acquisition route and boundary of PKG11 relation-model evidence; a passing authored fixture cannot replace this decision. |

### B37 — Archive completed evidence without losing provenance

Document claims: `docs/research/model-profile-engine-evidence.md`, `docs/research/retired-interaction-engine-evidence.md`, `docs/plan/qualification.md`.

Additional claimable paths: `scripts/qa/coverage.ts`; `scripts/qa/cli.ts`; `tests/qa/unit/coverage.test.ts`.

Checks: `task docs:check`, `task test -- tests/qa/unit/coverage.test.ts`.

After B00 changes the qualification writer/links. The manager copies the exact dated records to archive/goals and verifies recoverability before removing them from the active tree. Do not open or mutate that branch from a worker; update current references in the integration link slot.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/research/model-profile-engine-evidence.md` | 46 | `archive` | `scripts/research/model_profiles/probe.py` and evidence.json; current `model/compiler` tests are independent | Move the completed Fluree/reference-validator record to archive/goals, preserving date and artifact provenance; retain any useful design lesson in B18. |
| `docs/research/retired-interaction-engine-evidence.md` | 59 | `archive` | `scripts/research/fluree_interactions_probe.py`; current Jena command tests are independent | Move the retired Fluree interaction experiment to archive/goals; its eleven checks must never be relabeled as current Jena qualification. |
| `docs/plan/qualification.md` | 282 | `archive` | `scripts/qa/coverage.ts` renderQualification; `scripts/qa/cli.ts` recording path; recorded run 20260927t101230-1616d8 | Preserve the exact backend-phase1 record on archive/goals; B00 must first emit future evidence outside this retired page and preserve the current plan pointer. |

### B38 — Consolidate navigation and retire the audit

Document claims: `docs/README.md`, `docs/architecture/README.md`, `docs/architecture/coverage.md`, `docs/contracts/README.md`, `docs/contracts/data-contract-map.md`, `docs/implementation/README.md`, `docs/services/README.md`, `docs/storage/README.md`, `docs/experience/README.md`, `docs/operations/README.md`, `docs/research/README.md`, `docs/testing/README.md`, `docs/plan/README.md`, `docs/plan/docs-audit.md`.

Additional claimable paths: `scripts/documentation/check_docs.py`; `scripts/documentation/test_check_docs.py`; `scripts/research/storage_architecture/docs-check.ts`; `docs/plan/README.md`; README.md; AGENTS.md; GOAL.md.

Checks: `task docs:check`, `task test -- tests/qa/unit/acceptance.test.ts tests/qa/unit/coverage.test.ts tests/qa/unit/backend-operation-map.test.ts`.

Final serialized hub cleanup after the owner batches. Its integration slot also owns each changed incoming-link source, including skills and package/research READMEs outside this audit inventory. Claim those exact paths from a reverse-link search rather than docs/**.

| Page | Lines | Verdict | Code owner or replacement target | Reason / surviving content |
| --- | ---: | --- | --- | --- |
| `docs/README.md` | 77 | `shorten` | Taskfile.yml; `docs/architecture/overview.md`; retained runbooks and decision pages | Target ≤30 lines: one entry to intent, owner code, operating procedures and current Goal; remove the 13-role taxonomy and stale implementation status. |
| `docs/architecture/README.md` | 44 | `merge` | `docs/README.md` | Fold architecture navigation into the single entry point; do not keep a second contract directory map. |
| `docs/architecture/coverage.md` | 45 | `encode` | `scripts/qa/cases/**` (new capability/invariant references); `scripts/qa/coverage.ts`; generated QA summaries | Generate capability/invariant-to-evidence navigation from typed declarations; do not preserve a manually maintained second coverage ledger. |
| `docs/contracts/README.md` | 21 | `merge` | `docs/README.md` | Link the few surviving intent/decision pages and generated API/model entry points from the main hub, then remove this contract catalog. |
| `docs/contracts/data-contract-map.md` | 185 | `encode` | `scripts/qa/cases/**` (new D01–D22/capability ownership metadata); `model/compiler/registry.ts` | Carry logical-domain coverage and pending visual/messaging obligations in typed owner metadata; this is not evidence that every listed domain is implemented. |
| `docs/implementation/README.md` | 17 | `merge` | `docs/development/README.md` | Fold the remaining how-to entry points into development; implementation schemas and examples live with their owning code. |
| `docs/services/README.md` | 18 | `merge` | `docs/architecture/services.md` | The short architecture boundary note can link actual executable owners without another service-design index. |
| `docs/storage/README.md` | 26 | `merge` | `docs/architecture/overview.md`; `docs/operations/README.md` | Fold selected storage decisions into architecture and operational entry points into operations; remove the obsolete workload-directory index. |
| `docs/experience/README.md` | 11 | `merge` | `docs/plan/frontend.md`; Storybook navigation | frontend-owned: replace the four prose-flow links with the frontend outcome and actual stories/journeys when their owners are ready. |
| `docs/operations/README.md` | 19 | `keep` | Taskfile.yml; `docs/operations/installation.md`, recovery.md, erasure.md | Keep the short operator navigation hub, updated to actual procedures and the relocated assembler fixture. |
| `docs/research/README.md` | 56 | `shorten` | Surviving decision records and `scripts/research/` evidence | Target ≤20 lines: unresolved choices and active decision reasons; remove completed engine history and duplicated selected-architecture prose. |
| `docs/testing/README.md` | 49 | `merge` | `docs/testing/test-harness.md`; `scripts/qa/cases/**` (new registry) | One operating guide plus generated case navigation replaces a separate prospective-test directory index. |
| `docs/plan/README.md` | 199 | `shorten` | GOAL.md; `scripts/goal/goalctl.ts`; current QA artifacts and archive/goals reference | Target ≤45 lines: current outcome, recorded milestone limits, next decisions and retained reading routes; archive obsolete S0–S3/stage plans and old documentation-check narratives. |
| `docs/plan/docs-audit.md` | 850 | `archive` | Worker handoffs, accepted replacement code and manager integration commits | After this migration finishes, preserve this audit on archive/goals and remove its plan link; do not turn it into another permanent status ledger. |

## Documentation tooling disposition

Keep `task docs:check`. `Taskfile.yml` invokes
`scripts/research/storage_architecture/docs-check.ts`, which runs the nine Python
regressions and then `scripts/documentation/check_docs.py`. The checker discovers
Markdown dynamically: root README, optional GOAL, `docs/**/*.md` and authored
research READMEs. It validates local targets, Markdown fragments and reachability
from `docs/README.md`; fenced/inline code is excluded. It does not validate
external URLs, runtime behavior or the truth of a code-path citation.

Ordinary deletions need **no whitelist, expected-file-count update or weaker
navigation rule**. Repair incoming links, preserve/repoint fragments and keep
the remaining runbooks reachable. This new audit itself needs the one plan link
because an unlinked page fails the reachability check.

Two narrowly scoped checker improvements belong to B38: include root `AGENTS.md`
(currently absent from `document_files`) and regression-test linking to replacement
code files after an old page is removed. Add authored source/skill README coverage
only where it is deliberately maintained; do not recursively validate installed
dependencies, generated documentation, `.temp` or the archive branch. Keep the
existing missing-target/fragment and orphan-page failures. Preserve the current
Task command; replacing the checker with a documentation platform adds no value
to this reduction.

B00 changes the QA consumers, not the documentation checker. Its validation must
prove unchanged IDs/exclusions, complete-case references, route existence and
qualification output before deleting their inputs. B28 separately relocates the
Turtle fixture and verifies actual native quickstart behavior. Neither dependency
is detected by a Markdown link check alone.

## Audit verification

This deliverable changes only this page and the navigation link explicitly
allowed in the brief. The inventory was checked against every baseline path and
line count, with no duplicate or omitted page, and the additional code/check
paths were checked for existence except explicitly proposed targets. The audit
does not alter schemas, migrations, runtime routes or generated artifacts.
`task docs:check` passed: nine checker regressions and 181 Markdown files.
`task test -- --affected --list` passed: two documentation paths and no affected
backend tests. No runtime suite or stack was started for this audit. Integration
must not treat that absence of selected runtime tests as permission to delete
B00's current Markdown inputs.
