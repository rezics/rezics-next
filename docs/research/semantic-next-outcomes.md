# Semantic next outcomes

Written 2026-11-03 against worktree base `4531d63d06` (`dev` at that commit). Sources:
`.temp/goal/supermanager/road/semantic.md` (snapshot 2026-11-02, `dev` `41f71ff824`),
`.temp/goal/supermanager/road/decisions.md`,
`docs/research/quality-round3-backlog.md`,
`.temp/goal/supermanager/dev-health-20261102.md`,
`docs/scope.md`,
`git log dev`,
and `bun tools/goal/src/cli.ts status` (store query of Semantic tasks).

Dispositions: **actionable** (unreserved remaining work), **already owned**, **already delivered**, **outside scope**.
Decision recorded here: Source receiving (road E2) is delivered as the configured maintenance frame and custody on
this base; remaining Library/Accounts seams and runtime price plumbing are other owners or dropped by decision X5.
Held task `1940b2af` waits on cancelled `b5587565` and will not start; continuation `02-rating-visibility-repair`
is the dispatchable rewrite.

Two continuation briefs: `.temp/continuation/01-related-read-freshness.md`,
`.temp/continuation/02-rating-visibility-repair.md`.

## Road outcomes (`semantic.md`)

| ID | Outcome | Disposition | Evidence |
| -- | ------- | ----------- | -------- |
| A1–A3 | Launch verticals, word count/diet, fixture expansion | already delivered | road: landed |
| A4 | Catalogue publication beyond 1,024 Types; Kind enrollment | outside scope | MD1, MD8, `docs/scope.md` catalogue grants. `5f5cbba0` and `39449f6e` integrated mixed presentation, not unbounded catalogues |
| A5 | Paged Type directory and exact descriptors (S2) | already delivered | `f2cc3c30` integrated; `e66833a1a4` and follow-ups on `dev`; consumers `3025a776`, `49281daa`, `02f7c16c`, `3ac11a13` integrated |
| B1–B2 | Editorial review, comparison, sources, classification, add-ons | already delivered | road: landed; dispatched 05–10 integrated |
| B3 | Write-review entry and Realm-board destination | already delivered | `dc2404f2` integrated (attempt 12); duplicate `30f77136` cancelled (MD6); `3ca4b7d7` retry integrated |
| B4 | Next contribution action; unsaved-draft protection | already delivered | dispatched 25–31 all integrated |
| B5 | Recipe recovery after definition refusal | already delivered | `5c748f1e` integrated |
| B6 | Value explanation under the current reader | already delivered | `ecc844cd` integrated |
| C1 | Subject route retry, Character reading, text, history, qualified credits | already delivered | named landings plus dispatched 16–19, 23 integrated |
| C2 | Related labels and disclosure stay current across client reuse | actionable | `ac65cfbb` cancelled after typecheck exit 75. `subject.ts` still keys `relatedLoads` on the pooled client and reuses a completed promise |
| C3 | Identifier correction against a refreshed Subject | already delivered | `7ddf2a6f` integrated |
| D1 | Static Zones, My Zones, starters, unsaved navigation, owner recovery | already delivered | road: landed; dispatched 07, 08, 15, 37 integrated |
| D2 | Failed Zone owner route retries in place | already delivered | `6f35fb92` integrated |
| D3 | My Zones and Create Zone from the shell | already owned | Web `road-01` composes existing `zonesNavigation` (MD4) |
| D4 | Saved scopes, mounted Collection unions, direct catalogue targets | outside scope | `docs/scope.md` Zones row; Z1 |
| E1 | Committed scope receipts | already delivered | road: landed |
| E2 | Prepaid Source receiving and reached-cost composition | already delivered | `46f11fb7` cancelled. `identity-source-consumer-custody.ts` and `withIdentitySourceConsumerMaintenance` are on `dev`. Remaining Library/Accounts cuts are foreign. Eight-axis prepaid quotes are removed by X5/MD7 |
| E3 | Flatten historical redirect chains to one-hop reads | already delivered | `de85ab0d` and `e115588d` integrated (S1, MD7) |
| E4 | Rating visibility and identity repair | actionable | `b5587565` cancelled; producer files absent from this base (present only on that branch). `1940b2af` held on that cancelled `after` |
| F1 | Subject reports through hide and take-down | already owned | Content `road-03`; MD2, no Semantic writer |
| G1 | Publication originals | already delivered | Product journeys exist; `198980eb` was kind verification and cancelled. Retry is promotion/environment, not a product brief |
| G2 | Context lifecycle originals | already delivered | Same: `acb5fed1` verification cancelled |
| G3 | Source and resource custody originals | already delivered | Same: `b0050190` verification cancelled; waits E2 and E3, both delivered as product |

## Decisions (`decisions.md`)

| ID | Question | Disposition |
| -- | -------- | ----------- |
| S1 | Historical redirect chains | already delivered with E3 |
| S2 | 1,024-Type / 4 MiB caps and paged directory | already delivered with A5 |
| S3 | `type` vs `kind` user wording | already delivered. Grammar in `docs/search-conditions.md`; Type consumers integrated. `library_copy_kind` is Collection presentation, not the catalogue selector |
| S4 | Automatic Collection presentation Kind | already delivered | `ea7f14acde`, `39449f6e`; unset means mixed |
| S5 | Public document composition plan | already owned | Search/content; not a Semantic writer |
| S6 | Commit-visible indexed cut | already delivered | `92452a54`, `e76fc49c` integrated |
| S7 | Consent labels and missing unit symbols | already delivered | first-scope classes 1 and 9 |
| S8 | Lost creator edition labels | already owned | Content inventory; Semantic Subject labels |
| Z1 | Zone union query | outside scope | with D4 |

## Health (`dev-health-20261102.md`)

| ID | Defect | Disposition |
| -- | ------ | ----------- |
| D1 | Historical construction pin (`pattern-safety.ts`) | already delivered | `f68bfb05` / `05b53171fb` |
| D2 | Bundled release drift (frames, digest, descriptions) | already delivered | `dae134b8` / `a17623e5e4` |

## Quality round three (Semantic-owned residuals)

| Lead | Disposition |
| ---- | ----------- |
| Zone `EditorFailure` status/code/pointers | already delivered | `error-guidance.tsx` shows human `FieldGuidanceList` and keeps pointers in `TechnicalDetails` |
| Missing unit label erases quantity | already owned | Semantic/Commerce meaning authority; Progress index amendment is Commerce |
| F14 raw ontology labels outside Search recovery | already owned | Search amends missing-metadata chips; other vocabulary stays Semantic authority, no new defect |

Failed dispatch notes `34-consistent-type-selector-language` and Zone withholding/cleanup/subject-page briefs (`42`–`44`) are not additional first-scope outcomes: S3 is delivered, and `42`–`44` are outside the Zones row in `docs/scope.md`.

## Live Semantic tasks at this writing

| Task | State | Note |
| ---- | ----- | ---- |
| `e9b004f8` | running | this planning task |
| `1940b2af` | held | `after` cancelled `b5587565`; superseded by continuation 02 |

No other Semantic task is ready, running, held, or stopped.
