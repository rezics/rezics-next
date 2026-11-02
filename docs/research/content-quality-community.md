# Community authority, bans and publication acceptance

This guide binds the third [Content outcome](../goals/content.md#done-when) to native acceptance. The
[community contract](../../services/kernel/src/community/README.md),
[Semantic Context lifecycle](../../services/kernel/src/semantic/README.md#community-context-lifecycle) and
[verification rules](../development/verification.md) own behavior and measurement requirements.
Bindings describe executable scenarios; they do not establish that a revision passed them.

Decision: preserve the existing Home population and shared growth observer; supplement frozen scenarios with a
separate Context delete/restore regression, and defer the clause's measured acceptance to integration.

## Native persona jobs

Paths in the tables are relative to `services/kernel/test/`. Each filename links to its native binding.

| User job                                                         | Personas and observable assertions                                                                                                                                                                                                                                                                                                                                                                                                          | Native binding                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create and manage a community without acquiring Global authority | Authenticated creators need Global creation grants; Realm creation also needs independent Space management. Membership and resource roles confer no Global grant. Anonymous creation is refused. Current role revocation takes effect on the next request.                                                                                                                                                                                  | [creation-membership-persona-http](../../services/kernel/test/community/creation-membership-persona-http.test.ts)                                                                                        |
| Join, leave and admit a member                                   | Members, moderators and outsiders use actual accepted workflows followed by native membership reads. Protected self-join is refused; owner admission succeeds. Leaving preserves the Space follow. A member cannot promote itself. Revoking the initiator before publication prevents membership, inverse and follow effects.                                                                                                               | [creation-membership-persona-http](../../services/kernel/test/community/creation-membership-persona-http.test.ts), [community-outcomes](../../services/kernel/test/community/community-outcomes.test.ts) |
| Enforce a ban before removal completes                           | A member with an independent direct Realm read grant can read before the ban. With the fixture worker stopped, the committed ban hides Realm, boards, thread/post, every thread sort and publications while SQL still shows live membership. The same reads stay hidden after removal settles. Public-floor controls remain readable; ban/unban and admission denials preserve unrelated state.                                             | [ban-protected-http](../../services/kernel/test/community/ban-protected-http.test.ts)                                                                                                                    |
| Keep unban, rejoin and following distinct                        | Ban removal permits a subsequent join; it does not restore membership. Public reading and Space following remain separate from Realm participation. A surviving independent read grant may permit a read after unban without membership.                                                                                                                                                                                                    | [ban-protected-http](../../services/kernel/test/community/ban-protected-http.test.ts), [community-outcomes](../../services/kernel/test/community/community-outcomes.test.ts)                             |
| Use local Context decisions without changing identity            | Anonymous readers, members, moderators, banned accounts and protected outsiders see only their permitted local view. Local accept/reject and value fallback preserve Global identity. Realm or Context authority cannot authorize a Global merge. The moderator's Context role is an explicit fixture grant, not authority inherited from a Realm role.                                                                                     | [context-fallback-persona-http](../../services/kernel/test/community/context-fallback-persona-http.test.ts), [realm-context](../../services/kernel/test/community/realm-context.test.ts)                 |
| Lose a Context without receiving a Global substitute             | Anonymous, creator, member, moderator and outsider readers first see a local rejection through a Context shared by public and protected Realms. Context deletion immediately makes subject overlays and candidate reads indistinguishable from unknown Contexts. Explicit Global reads still succeed unchanged. Restore retains the local rejection and Context ID. The public Realm supplies the positive anonymous/outsider read control. | [context-disappearance-http](../../services/kernel/test/community/context-disappearance-http.test.ts)                                                                                                    |
| Publish, withdraw, reject and republish                          | Moderator and owner success controls exercise the current slot/head. Anonymous, member, banned subject owner and protected outsider refusals leave native tables unchanged and disclose no publication metadata. Subject takedown hides an adopted slot without rewriting it. Global identity and subject rights remain unchanged.                                                                                                          | [publication-persona-http](../../services/kernel/test/community/publication-persona-http.test.ts), [publication-http](../../services/kernel/test/community/publication-http.test.ts)                     |
| Refuse suspended credentials                                     | The outcome suite exercises suspended community writes after active positive controls. The publication HTTP suite independently covers publish/withdraw/reject with old credentials and no writes. Suspension is a native account command.                                                                                                                                                                                                  | [community-outcomes](../../services/kernel/test/community/community-outcomes.test.ts), [publication-http](../../services/kernel/test/community/publication-http.test.ts)                                 |

The [frozen outcome scenarios](../../specs/community-outcomes.test.ts) load through the native wrapper and
[community driver](../../services/kernel/test/community/community-driver.ts). Keep those scenarios intact.
The additional disappearance case exercises ordinary Context lifecycle through the same production HTTP boundary;
it does not seed a deleted state or implement a second reader.

## Fixture requirements

Use the owning kernel runner's isolated migrated PostgreSQL databases, released definitions, native Auth-issued
credentials and consent, production Access, the real kernel handler and durable-work worker. The existing driver
creates subjects, Contexts, grants, Spaces and Realms through APIs. Subjects have an independent Global owner;
community creation must not manufacture rights on that subject. Native Accounts owns membership transition
coordination and ownership succession; Community supplies its documented native writer and proofs.

An accepted `202 { workflowId }` is not completion. Settle the actual workflow and inspect native membership and
follow state. Only the ban barrier deliberately pauses its own fixture worker; retain the live membership assertion
before denied reads and restart in `finally`. Never pause shared workers or another attempt's resources.

For growth, keep selected IDs, page sizes, authority operands and result neighborhoods fixed. Administrative
population seeding may grow unrelated records and history; it must not seed the workflow result being asserted.
Keep the integrated Home owner's `growthFixture()` and publication population. Do not replace them with a smaller
population or a special reader. Restore and deletion use the native Semantic contract, not direct SQL updates.

## Cost operation map

These are mappings to existing checks and explicit remaining measurements, not measured results. The community
[Cost section](../../services/kernel/src/community/README.md#cost) retains the owner bounds. Unless stated otherwise,
existing growth checks require constant examined rows and statements, logarithmic buffers, and three scales of
256, 1024 and 4096. Preserve the assertions, classifier, security windows and budgets.

| Owning operation                                                     | Existing native growth binding and population                                                                                                                                                                                                                                                     | Remaining qualification                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Space create/read/update, including carried Realm on read            | [growth-space](../../services/kernel/test/community/growth-space.test.ts): unrelated Spaces, carried Realms, eight revisions per seeded Space, grants and command history; real Access on the viewer read.                                                                                        | [growth-container-reads](../../services/kernel/test/community/growth-container-reads.test.ts) adds empty carried-Realm and explicit denied Space reads, plus hidden carried Realms. Population and retained revision/command history grow in separate three-scale series; execution remains deferred.                                                                    |
| Realm create/read/public-read/update                                 | [growth-realm](../../services/kernel/test/community/growth-realm.test.ts): unrelated Realm/Space identities, revisions, grants and command history; protected and public reads are distinct operations. Population uses eight seeded units per scale.                                             | [growth-container-reads](../../services/kernel/test/community/growth-container-reads.test.ts) adds missing and anonymous/outsider protected reads with separate population/history growth. These bindings require execution; lifecycle transitions are bound separately below.                                                                                           |
| Join/leave/add-member, including follow and inverse effects          | [growth-join](../../services/kernel/test/community/growth-join.test.ts): scales 1, 4, 16 with 500 population rows per scale unit; the measured operation includes HTTP acceptance, worker completion, membership verification and follow verification.                                            | Run this supplement: lower-level membership publication alone does not measure the workflow. Retain DBOS and Access work inside capture.                                                                                                                                                                                                                                 |
| Native membership publication, terminal/change proofs and role reads | [growth-membership](../../services/kernel/test/community/growth-membership.test.ts): native membership, terminal, grant, receipt and outbox neighbors; fixed selected members and proofs.                                                                                                         | This is a writer/proof measurement, not join/leave completion. Shared transition coordination additionally belongs to Accounts.                                                                                                                                                                                                                                          |
| Current membership and same-key interval history                     | [growth-membership-history](../../services/kernel/test/community/growth-membership-history.test.ts): closed intervals on one account/Realm grow alongside a separate, faster unrelated-key population. Exact current lookup requires one statement, one examined row and the open-interval index. | This supplement is needed even when unrelated-member growth passes. Its single combined progression does not alone isolate the two growth axes.                                                                                                                                                                                                                          |
| Ban/unban/list and protected-read/admission ban probes               | [growth-ban](../../services/kernel/test/community/growth-ban.test.ts): HTTP mutation/list work with Realm, member, ban, grant and command neighbors; a second series grows bans inside one Realm and checks present/absent probes.                                                                | Two-page list traversal is asserted after the measured series; it is not a measured deep-page bound. Add empty-list, denied mutation/read, deep cursor and pending-removal operation series before claiming those costs.                                                                                                                                                 |
| Publication write and listing                                        | [growth-publication](../../services/kernel/test/community/growth-publication.test.ts): three scales multiplied by eight, native publication/command neighbors, fixed two-item page with lookahead and real publisher Access.                                                                      | The write series republishes the selected slot. Empty/denied, deep pages, withdraw/reject and subject-disappearance physical series are not established by the persona tests or this adoption series.                                                                                                                                                                    |
| Hot board page and membership HTTP read                              | [community-outcomes](../../services/kernel/test/community/community-outcomes.test.ts): existing Home native population; fixed two-thread neighborhood, independently queried Realm/member/thread counts at each scale; three measured repetitions.                                                | Preserve this binding. It does not establish every sort, deep page, empty/denied path or independent history growth.                                                                                                                                                                                                                                                     |
| Board scheme adoption and board creation/listing                     | Functional bindings are the native outcome and community HTTP suites.                                                                                                                                                                                                                             | The selected Space/Realm growth operations do not execute scheme adoption or board commands. A dedicated current-scheme, authority and board-page physical measurement remains required.                                                                                                                                                                                 |
| Context decision/fallback and disappearance/restoration              | Persona bindings above; [Semantic lifecycle growth](../../services/kernel/test/semantic/growth-context-lifecycle.test.ts) measures raw lifecycle HTTP and current reads, with separate history/population series at 64, 512, 4096.                                                                | Run the Semantic supplement for lifecycle cost. Community-bound candidate decision/fallback and protected-denial measurements still need their own operation coverage.                                                                                                                                                                                                   |
| Container lifecycle and current binding fences                       | [container-lifecycle](../../services/kernel/test/community/container-lifecycle.test.ts) checks native binding invalidation, retained Context pointers and refusal to restore with a deleted Context.                                                                                              | [growth-community-lifecycle](../../services/kernel/test/community/growth-community-lifecycle.test.ts) adds native Space/Realm removal and restoration cycles with stale Access and binding fences, independent Context reads and retained heads/pointers. Separate population/history series use the existing three scales and owner bounds; execution remains deferred. |
| Shared Realm transition coordination                                 | [Accounts growth binding](../../services/kernel/test/access/growth-realm-membership-transition.test.ts), referenced by the community transition-publication contract at 64, 512, 4096.                                                                                                            | Accounts owns this evidence and any failed shared authority assertion; do not change Access or succession from this slice.                                                                                                                                                                                                                                               |

## Commands and retained measurements

Run from the repository root through normal heavy-check admission. The initial selection is exactly ten files:

```sh
bun run --cwd services/kernel check \
  test/community/community-outcomes.test.ts \
  test/community/ban-protected-http.test.ts \
  test/community/creation-membership-persona-http.test.ts \
  test/community/context-fallback-persona-http.test.ts \
  test/community/publication-persona-http.test.ts \
  test/community/growth-ban.test.ts \
  test/community/growth-membership.test.ts \
  test/community/growth-publication.test.ts \
  test/community/growth-space.test.ts \
  test/community/growth-realm.test.ts
```

The supplemental community selection covers the new regression, same-key history, workflow work, suspended
publication and existing Context/container boundary assertions without exceeding twelve files:

```sh
bun run --cwd services/kernel check \
  test/community/context-disappearance-http.test.ts \
  test/community/growth-join.test.ts \
  test/community/growth-membership-history.test.ts \
  test/community/publication-http.test.ts \
  test/community/realm-context.test.ts \
  test/community/container-lifecycle.test.ts
```

The added container boundary selection is:

```sh
bun run --cwd services/kernel check \
  test/community/growth-container-reads.test.ts \
  test/community/growth-community-lifecycle.test.ts
```

The companion [container growth fixture](../../services/kernel/test/community/growth-container-fixture.ts) uses
native Auth/consent, released definitions, production Access and the real handler on the shared observer's pool.
Population series grow unrelated Space/Realm identities, revisions, role grants and command history in the selected
partition; history series grow only retained revisions on the fixed selected keys and command history. No series
seeds its asserted read or removal/restoration result. The selected heads, roles, visibility and Context pointers
remain fixed. Every lifecycle repetition includes both commands, fresh authorization, current lifecycle reads and
stale/fresh binding validation. These commands have no asynchronous removal workflow. Home's fixture is unchanged.
Ban/publication boundaries, board scheme/board commands and community Context decisions/fallback still require
separate physical bindings; the existing positive series and persona regressions do not establish those costs.

The owning managers' additional growth selections are:

```sh
bun run --cwd services/kernel check test/semantic/growth-context-lifecycle.test.ts
bun run --cwd services/kernel check test/access/growth-realm-membership-transition.test.ts
```

Use the [shared growth observer](../../services/kernel/test/support/growth.ts) and classifier for all measurements.
Set `GROWTH_PROFILE` to a workspace path such as `.temp/community-growth.jsonl` and
`GROWTH_PROFILE_REQUIRED=1` when retaining physical evidence; the runner returns workspace-relative profiles from
remote placement. Keep artifacts in `.temp/`, outside tracked documentation. Profiles contain actual per-repetition
rows, buffers, statements and relation evidence, alongside scale/population and classifier information. Count worker,
Access, lookahead, discarded work and command verification inside each operation; fixture preparation is not product
work. A returned page length, declared bound or elapsed time cannot substitute for native physical counters.

Bind every result to its exact committed source revision, full command, runner check identity, exit status and
returned artifact paths. Retain reached JUnit assertions and all three scales' repetitions, plans and counters;
identify which empty, denied, cursor and lifecycle operations were actually captured. A queued run, missing setup,
infrastructure exit 70/75 or source inspection proves no product pass. Do not call a single failure flaky.

## Integration and external conditions

The worker launch policy defers the frozen acceptance and growth executions to integration. Adding this guide or
the missing scenario does not close the clause's measurement gap. A focused regression result does not replace the
initial selection, its supplements or the explicitly missing operation measurements above. Retain stale manifest
claims until executed native evidence supports correcting them; an existing file alone is not a passing binding.

The native Home owner is integrated in the supplied base; preserve its implementation and data ownership.
Check-host placement, migrated databases, native Auth/consent and worker startup remain execution prerequisites.
Ownership succession and shared authority failures go to Accounts with the exact failing assertion; the Semantic
owner receives Context lifecycle defects. This guide establishes no production deployment or main-promotion claim.
