# Native Zone site journey

This ledger freezes the site journey in [user-site.test.ts](../../test/zones/user-site.test.ts). It records native
bindings separately from required outcomes that cannot yet be bound. It does not establish runtime readiness.
[Zones](../../../../docs/zones.md), [membership](../../../../docs/zone-membership.md),
[Collection sources](../../../../docs/collection-source.md) and [filtered lists](../../../../docs/filtered-lists.md)
remain the authorities for behavior, disclosure, transport and cost.

## Frozen entry points

- `published routed Zone serves a common page and a currently eligible direct subject`
- `source restriction and cursor reauthorization never borrow private Collection or subject grants`

The SHA-256 of the repository-formatted test file is recorded below after formatting. Changing these assertions
requires the acceptance owner's adoption; runtime workers must not relax them to accept readiness or missing routes.

Test file SHA-256: `9a9962f186703d3b07b38d355e8dd914b979287a6f27189068d0768f083c38f2`.

Run from the worktree root:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/zones/user-site.test.ts
bun scripts/worker-check.ts -- bun run typecheck
```

## Actual native bindings

Both cases reuse the committed `resourceFixture` without changing its database, authentication, grants, profile or
kernel setup. All Zone configuration, publication, subject creation, Collection creation, curated occurrence and
source-grant mutations in the journey use mounted owner HTTP APIs. Existing fixture grants provision access to
the closed Collection surface and the Zone viewer. They do not manufacture Collection membership or page results.

| Cell                     | Bound assertion and evidence boundary                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static routed site       | Actual create, configure with conditional revision, publish, then anonymous home POST must give a complete common page, exact configured document, empty reads and closed public shell. This is the first outcome assertion, before any Search or Collection setup. A 404, 202 or 503 fails it.                                                                                                                  |
| Routes and languages     | Every launch UI locale reads the configured about document and the same shell. Unknown route gives 404. A deliberately empty static document gives complete 200 with empty reads. Static copy is not translated by language negotiation.                                                                                                                                                                         |
| Curated direct target    | Actual public subjects and overlapping curated mounts supply a member. Browse yields one canonical card per subject in canonical order despite occurrence/source order and duplicate occurrences. The direct target uses the common subject document and native subject read, with default overview. Readable nonmember and unknown target give the same not-found problem.                                      |
| Released saved scope     | Actual `book/all` configuration overlaps curated mounts and admits the Book direct target with explicit overview. A Recipe control remains outside that union. This is a routing/source control, not a second implementation of the discovery predicates. Native indexed convergence is still required.                                                                                                          |
| Source removal           | Removing all scopes and mounts conceals the former direct target, preserves a complete configured route and distinguishes genuinely exhausted membership from a raw filtered-empty window.                                                                                                                                                                                                                       |
| Private mount            | A Zone reader can read a static route without seeing the private mount's identity or title. The source owner can address the member; the Zone reader cannot until a real Collection grant is issued. Grant and revoke use the native grants endpoints and a native Collection read as the control.                                                                                                               |
| Current authorization    | Revocation denies the direct target before this suite advances any ordinary projection. Regrant followed by mount removal also denies it, even while its global subject remains readable. Zone grants alone supply neither source nor subject permission.                                                                                                                                                        |
| Unusable POST cursor     | A valid-shaped unusable query cursor restarts the static route, while the same cursor on a now-denied direct target remains denied. This does not claim to exercise an issued preparation token.                                                                                                                                                                                                                 |
| Native progress observer | If dynamic direct reads return 202, the observer validates the closed `{next}` schema and private/no-store, follows query continuation and requires eventual complete 200 within the test's existing timeout. A 503 validates the standard Problem and Retry-After without a cursor or partial document, then fails the journey. The observer alone does not force preparation or prove durable worker progress. |

The case does not re-freeze ownership/CAS/idempotency/deletion, route admission, closed typed schemas, canonical
membership growth, built-in/private facts or Search's four predicates across its six surface cells. Those assertions
remain in the existing resource, validation, typed, membership, continuation, growth and released-discovery suites.
No existing frozen test changes here.

## Required unbound native cells

Each row is **NOT YET FROZEN** as a complete native scenario. A route-level red and assertions behind it are not
evidence that these worker-dependent paths execute. No fake source, replacement Search callback, SQL-created
persona, invented fixture export, unconditional failure placeholder or skipped test supplies the missing binding.

Public subject control readiness: **NOT YET FROZEN.** The actual private Collection create and subject create
return 201, but the second case's anonymous native subject control returns 503 before occurrence/mount setup.
The fixture's bootstrap is not proof of ready subject disclosure. Need native default readiness/catch-up
sufficient for the control to return 200 before claiming a source-grant journey. Do not bypass the control or
accept its 503.

| Cell                                           | Exact missing binding and required native outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained preparation and unavailable transport | **NOT YET FROZEN.** Need an admitted native composed plan that deterministically enters retained preparation and a controllable real worker lifecycle. Capture actual 202, interrupt/replay the owning worker, follow beyond four server steps, and reach complete 200 on fixed finite input. Separately make a real dependency unavailable: require 503 standard Problem + Retry-After, no replacement cursor and no partial document. Four follows is Web rendering policy, never server EOF.                                                                      |
| Issued cursor reauthorization                  | **NOT YET FROZEN.** Need an actually issued native POST preparation token. Restrict a source, revoke its viewer grant, change Zone visibility/configuration and publish an identity epoch change while ordinary projection delivery is paused. Replay each actual token under current authority. No source/subject disclosure may survive a reduction; obsolete bases restart rather than becoming permission. Include different principal/request and expired/unusable valid-shaped progress. Current tests bind only the unusable-token restart and direct denial. |
| Hidden original with readable terminal         | **NOT YET FROZEN.** Need the shared fixture's native identity lifecycle and current original/terminal disclosure controls. Mount a real original, publish its canonical terminal, hide only the original, and prove direct/list denial despite the readable terminal. Restore an eligible original and prove finite convergence and one canonical target. Existing membership/identity assertions remain authoritative; no fabricated redirect or takedown row substitutes.                                                                                          |
| Saved scopes and overlapping prepared mounts   | **NOT YET FROZEN.** Configuration and HTTP assertions are bound, but actual same-service compiled scope execution, complete indexed observation and the Commerce source implementation are absent. Exercise scope-only, mount-only and overlap through real admitted plans; prepared and direct paths must agree on canonical unique order, current eligibility and genuine exhaustion. Reuse Search's fixture populations and expected predicates rather than rebuild them here.                                                                                    |
| Paused ordinary projections                    | **NOT YET FROZEN.** The test advances no projections around source-grant revocation, but this is not a worker pause/resume harness. Need actual ordinary relay/search worker pause, authoritative source/subject reductions, privacy acknowledgement and resumed refresh-visible repair. Lists/pages may prepare while unsafe; they may not return stale exclusion/order or manufacture EOF.                                                                                                                                                                         |
| Native account suspension                      | **NOT YET FROZEN.** Need the Accounts lifecycle fixture to suspend a real signed-in account and retain its pre-suspension bearer. That revoked bearer must yield kernel 401; Accounts password sign-in must yield 403 `ACCOUNT_SUSPENDED` without a session. `resourceFixture`'s SQL-suspended persona and verified-suspended kernel 403 are defensive tests only and remain unchanged. They are not used as this journey's native persona evidence.                                                                                                                 |

## Committed dependencies and minimal next work

Read surfaces for this freeze: `zones/contract.ts`, `page-continuation.ts`, `http.ts`, `resource-commands.ts`,
`resource-reads.ts`, the mounted kernel and common presentation page routes; every existing native Zone suite and
`resource-fixture.ts`; `test/support/released-discovery.ts` and its native fixture tests; Search's service/scope
handoff and Commerce's Collection routes/source factory. No external reference implementation is named by these
contracts or used for this site-only freeze.

The committed shared discovery fixture exports `createReleasedDiscoveryFixture`, `releasedDiscoveryVersion`,
`discoveryKey`, `discoveryStatement` and the corresponding public types. Its actual constructor accepts only
`{version: 1}`. Its subjects, adoption, release pins, classification/books/recipes, request and catch-up operations
are usable only within their published capabilities. Its sources, privacy, personal, profiles and platform fields
are prerequisite records. Its catch-up runs link projection, not Zone/Search preparation or identity maintenance.
Search owns its lifecycle extension. This freeze neither modifies it nor assumes options for injected resources,
workers, transport, truth or a different version. `resourceFixture` supplies the existing site shell setup; it does
not supply missing lifecycle control through its suspended persona.

The smallest runtime prerequisites, in dependency order, are:

1. Mount the real Zone readPage command using the existing request/query schemas and common page envelope. Serve
   static configured pages through current Zone authorization and the common shell immediately; no catalogue
   engine is necessary for the first red. Keep the common codec and other GET behavior unchanged.
2. Implement the actual Commerce source and Search same-service scope handoffs, with complete observations and
   current source/original/terminal authority. `createCollectionSource` currently reports dependency unavailable;
   `createSearchScopeForService` reports index not ready even for a registered service. Their exports establish
   no default execution. Add the Zone direct-target and union wiring only against those native capabilities.
   Establish the real subject control's native read readiness as well: this run reaches creation but not a
   successful public read. No replacement subject response can supply that dependency.
3. Connect admitted retained preparation, canonical epoch publication and privacy repair to the existing durable
   work infrastructure. Expose the real worker lifecycle through Search's shared fixture extension, including
   interruption, pause/resume and refresh-visible acknowledgement. Bind the unbound cells above against those
   committed exports before claiming finite convergence or issued-token reauthorization.
4. Consume the Accounts native suspension/sign-in fixture when committed. Preserve the existing defensive tests.

No new Source/Collection/query engine, product runtime, profile, budget, scheduler or cursor protocol is specified
or implemented by this change. The site journey uses the owning contracts' current numbers and protocols.

## Recorded verification

The focused native command ran once after the last test edit and exited 1: zero passing cases, two failing cases.
The first case successfully creates, configures and publishes the static Zone, then observes HTTP 404
`not_found` where the complete home page requires 200. The mounted Zone resource routes contain no readPage
command. This is an actual native page red, not readiness accepted as success.

The second case creates the private Collection and the subject through HTTP, then its anonymous native subject
control observes 503 instead of 200. Its assertion does not capture that response's problem code; this evidence
does not identify a particular unavailable dependency. Curated occurrence, mount, grant and continuation
assertions beyond that control were not reached. None of the downstream cells is claimed to have passed.

The check waited for a shared slot and completed normally. Its ancillary warning that check timings could not
read Git metadata did not prevent native execution. Evidence:
`.temp/goal/checks/worker-check-2026-10-28T18-38-20.940Z-9c8a2e72.log`.

Root typecheck ran once and exited 0. Evidence:
`.temp/goal/checks/worker-check-2026-10-28T18-39-34.669Z-fa4aece5.log`.
No product runtime or existing acceptance file was changed, and no file outside the two declared paths was
changed. The tests' formatted hash above remains the frozen content.
