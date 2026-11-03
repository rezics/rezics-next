# Edition exact revision delivery growth

Bound source: `d50464392475ae4a76362a7ed0bb1e9646126501`. The brief's inspection revision,
`e21850110a75d916451a03711b9035610db998bf`, is not this attempt's base. The owning operation is
“Edition sale/mechanical eligibility/byte read” in [Content Cost](../../services/kernel/src/content/README.md).
The private suite binds its authenticated byte-delivery portion to
`GET /v1/contentEditions/{id}/revision`, rather than invoking the eligibility helper.

## Native composition and prerequisite

The fixture uses `openGrowthDatabase`, the existing `nativeFixture` registered Auth host, real native account
registration, native sign-in/token/consent and `testKernel`'s installed production Access/runtime defaults.
Auth receives `db.openPool` before opening connections; its database URL is selected by the native fixture.
Consequently current consent and restoration SQL participates in the same physical capture as the request.
No Content evaluator, Commerce entitlement, publication operation, receipt or selected resource is synthesized.
The publisher is the natively bootstrapped governance account as well as the actual source/edition owner, so
its resource-local actions and platform grant-management action admit ordinary grant commands.
The mounted native write limiter has a fixture secret and unchanged production budgets.

Premise correction: the focused `edition.test.ts` creates a protected thread using HTTP, but on the bound base
`ThreadInputSchema` admits only `published | draft`. `PostInputSchema`, `RevisionInputSchema`, `createPost` and
`revisePost` also have no protected-state producer. Content's owner document explicitly refuses protected-state
revision changes. Existing tests' `seedGovernanceAuthority` and `seedResourceDenial` write Access rows directly;
the new fixture does neither. There is no public resource-denial command. The protected-source exemption cannot
be reached through the promised selected native producers on this source. Its exact owning prerequisite is the
Content creation/visibility seam in `src/content/{schemas,commands,routes}.ts`, requiring a subsequent owning brief.

Decision: measure the reachable published-source delivery through native protected Realm/board guards; retain the
protected-source exemption and protected-ancestor refusal as a continuation until their native producer is admitted.
This introduces no new audience. The recipient receives direct edition, Realm and board grants through supported
commands; the non-member receives only the edition grant. Source-post read grants are never written for either.
Ordinary reads of a published source can already succeed through its public eligibility and authorized parents;
absence of a newly written post grant does not prove the unavailable protected-source HTTP outcome.

## Independent populations and capture

Each axis starts with a fresh fixture and uses 256, 1024 and 4096 additions, preserving one selected exact revision,
canonical body, licence, subject, scopes and three-post chain. There is no page, entitlement enumeration or byte copy.

| Axis                         | Producer outside observation                                                                                       | Fixed selected operand                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Unrelated editions/revisions | Shared `seed` helper; draft edition pointers and revision rows on a separate native post in the selected partition | Selected edition, revision, provenance and publication untouched                |
| Selected source history      | Production `revisePost` with native authenticated publisher and head precondition                                  | Original selected revision and body remain pinned despite different later heads |
| Recipient grant history      | Production grant commands; disjoint expired intervals on the selected edition                                      | One current direct recipient `edition:read` grant                               |
| Publisher grant history      | Production grant commands; disjoint expired `post:revise` intervals on the selected source                         | Current native owner role and publication initiator                             |

Only unrelated pressure uses bulk rows. Selected history and grants use native command transactions, receipts and
outbox producers. Their command envelope is setup, separately named here, not byte-read cost. Source cleanup uses
the existing `clearErasedPostRevisions` unchanged outside measurement; it is not reimplemented or called byte-read work.

The observed callback begins before the real authenticated HTTP request and ends after its response is consumed.
It includes publisher restoration, current consent, exact operation/receipt/source validation, independent buyer
edition Access and source/parent preparation and final guards. The shared `checkGrowth` classifier receives actual
native plan rows, shared hits/reads and statements, with constant rows/statements/bytes and logarithmic blocks.
No planner setting, budget, slack or assertion is relaxed. Auth and kernel database identities must both be present;
all observed relation access paths are checked. Structural bounds remain one revision at most 2 MiB, at most
33 posts, existing Access limits and one unchanged 1,000 ms restoration deadline. This fixture uses three posts
and a small fixed body; it makes no maximum-body/maximum-ancestry performance claim.

## Authored assertions and execution limits

The suite asserts exact `{editionId,revisionId,sha256,licence,body}`, canonical digest/native pinned bytes, private
no-store, and full 200 responses despite matching conditional headers. The positive trace must contain native
publisher sale/source authority and both preparation/final subject, board, Realm, Space, thread and ancestor checks.
Only the selected post is omitted from buyer source-post checks. Actual body selection must name the exact pin.

Native outcomes cover edition-granted non-member refusal with an authorized owner/recipient control, missing caller
edition grant, terminal unpublication, source takedown, deletion and physical source-byte erasure, and publisher
edition-owner and source-owner role revocation. Conditional refusals must never produce unchecked 304 or body bytes. Calibrated SQL barriers
revoke recipient edition, board and Realm grants before their last native guard snapshots. SQL faults exercise native
source unavailability/deadline errors; holding the actual source boundary past 1,000 ms exercises the real deadline.
Expected errors are 401 for anonymous access, 404 for unavailable/unauthorized content and 503 for unavailable native
publisher restoration, source connection failure or deadline expiry.

These are authored assertions and source reasoning, not measurements or an executed growth result. The controller
owns acceptance admission after integration. No growth row, proof registration, main-promotion claim or shared
fixture/owner specification is changed. The remaining protected-source/ancestor scenarios are explicitly retained
in the private continuation; the existing frozen consumer tests remain untouched.

Read sources: focused `edition.test.ts` and `edition-mechanical.test.ts`; Content's Edition owner/Cost section;
Content Goal Done-when/Acceptance; `edition-{reads,store,sale,sale-native,initiator,sale-consent,commands,routes}.ts`;
Edition source guards in `reads.ts`; Content command/input and cleanup contracts; native Auth/content fixtures;
production grant command and role catalogues; shared growth capture/classifier/seed/access-path code and the
existing Realm asset publication growth composition. No external reference source is named by this slice.
