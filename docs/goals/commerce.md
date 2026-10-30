# Commerce

## Outcome

A buyer can discover a subject's offered benefit, inspect accepted terms, pay through hosted Checkout, find the
owned benefit later and actually use it through current Access. Creators manage offers, inspect sales and understand
attributed earnings and external royalty payment evidence without a second processor catalogue.

## Done when

- Subject entry, offer, hosted Checkout, private purchase/owned-benefit navigation and final protected use form one
  journey through ordinary APIs, native storage and reviewed pages. The first target is an exact authored native Content edition (`content.edition`, `edition:read`, revision ID and
  SHA256). Real Content sale authority, Accounts opaque benefit facts and final Content reads must be delivered
  before protected-use completion; bounded subject discovery remains a shared delivery.
- The one-time account-bound, one-fixed-version-benefit/quantity-one contract captures immutable accepted terms;
  historic subject-only orders remain unknown until explicitly authorized mapping. Repricing/delisting cannot edit
  a captured sale; current availability and rights remain separate.
- Fulfilment has one durable effect: buyer-home order, entitlement and named payment evidence change atomically.
  Signed events schedule fresh bound reads; redirects, history and Library presence never authorize use.
- Creation uncertainty, evidence completeness, immutable movement economics and bounded signature/secret inputs
  satisfy the owner contract. Exact replays have one effect, conflicts reconcile, incomplete evidence never grants
  or restores, and terminal account fences prevent personal-benefit resurrection.
- Creator offer/sales/statement views distinguish historical payment, current entitlement, provider bank payout,
  attributed earnings, reserves/payability and actual external payment attestation. Remaining commercial/shared
  additions require explicit adoption before runtime bodies; accounting unknowns are visible.
- Financial erasure/custody and actual physical cost meet their shared owner contracts. Provider eligibility and
  private setup remain external; fixtures do not claim production qualification.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Offers, benefit definitions/versions, checkout orders, payment evidence, purchase-derived entitlements, creator sales,
royalty statements and the pages completing those journeys. The
[Commerce owner contract](../../services/kernel/src/commerce/README.md) owns behavior. This documentation separation
retains the **same commerce manager**, all original tasks and native/main requirements. The
[Library Goal](library.md) retains the personal Library/Collections/progress/copies/labels/follows obligations under
that manager; none moves to a new control-plane Goal or becomes deferred.

First scope is direct licensed sales on one US Stripe account with hosted Managed Payments. No bundle, gift,
subscription, consumable, wallet, issued token/points, transferable item, market, exchange or ledger implementation.
[Future modules](../commerce-modules.md) is the sole future module map, not additional current financial scope.

## Ownership

Owns `services/kernel/{src,db,test}/commerce/**` and Commerce journey pages in `apps/web` using Web's shell/patterns.
Web owns shared navigation, UI patterns, Storybook organization and visual review. Existing Web checkout/history
producers remain coordinated handoffs, not duplicate assignments. Root binds cross-owner choices; Content owns the
actual protected target and sale authority, Accounts Access/account lifecycle, Semantic subject identity/discovery.
No permission, rights, disclosure, deletion or account mechanism is duplicated here.

## Dependencies

Requires semantic references/redirects and disclosed subject entry; target-owner version/action and sale authority;
existing Access/resource grants and current eligibility integration; shared command receipts, durable work and
retention/custody. The adopted native edition and precise pending producer/use bindings live only in the
[owner contract](../../services/kernel/src/commerce/README.md#adopted-native-content-edition-and-delivery-state).
Commerce capture storage/HTTP and fail-closed unavailable admission are source deliveries, not native sale/use proof.
The sole offer-consent delivery owns expectedOfferRevision and its request digest. None waives the full journey.

## Acceptance

Retain [Commerce outcomes](../../specs/commerce-outcomes.test.ts), native commerce suites and scoped growth evidence.
Cover buyer, refunded buyer, same-route other buyer, creator/seller and other creator/seller, anonymous,
suspended/terminal and repair-operator personas. Use signed fixtures without live processor calls, real native
Auth/Access/kernel/DBOS boundaries and actual provider-adapter requests. Preserve frozen tests and the two narrow
accepted uncertainty/future-status exceptions in the owner contract; do not claim other Root outcomes changed.

Connect entry/offer/return/history/owned-benefit/use and creator views to actual APIs, recorded-response stories,
Web review and screenshots under [verification](../development/verification.md). Native storage, bounded execution,
reviewed interface and promoted-main evidence remain required. Docs-only adoption is not that test campaign.

### Native Library outcome binding readiness

The kernel runner entry points import the original outcome specifications through their expected environment
variables. They do not rewrite assertions, normalize responses, or treat a missing driver as a successful check.

| Specification | Kernel entry point | Native source status |
| --- | --- | --- |
| [Library](../../specs/library-outcomes.test.ts) | [outcomes](../../services/kernel/test/library/outcomes.test.ts) | Existing [driver](../../services/kernel/test/library/support/outcome-driver.ts); whole-suite acceptance unverified. |
| [Labels](../../specs/library-labels-outcomes.test.ts) | [labels-outcomes](../../services/kernel/test/library/labels-outcomes.test.ts) | Existing entry point; `support/native-labels-driver.ts` is absent. |
| [Profiles](../../specs/library-profiles-outcomes.test.ts) | [profiles-outcomes](../../services/kernel/test/library/profiles-outcomes.test.ts) | Existing entry point; `support/native-profiles-driver.ts` is absent. |
| [Dynamic Collections](../../specs/dynamic-collections-outcomes.test.ts) | [dynamic-outcomes](../../services/kernel/test/library/dynamic-outcomes.test.ts) | Existing entry point; `support/native-dynamic-driver.ts` is absent. |
| [Shelves](../../specs/library-shelves-outcomes.test.ts) | [shelves-outcomes](../../services/kernel/test/library/shelves-outcomes.test.ts) | Existing entry point; `support/native-shelves-driver.ts` is absent. |

The authorized [entry lifecycle reconciliation](../../services/kernel/src/library/README.md#entry-deletion-identity-and-restoration)
is now represented in the original Library, profile and shelf specifications. The two historical-profile clear cases
require `204` and an empty body. Revisioned writes and deletes explicitly carry the incarnation captured from an
actual native entry response. Shelf response-key assertions include that incarnation. Migration concurrency captures
the original native guard before pausing work; adapters never fetch a replacement guard. The Library suite also
requires missing/foreign guard denial, concurrent CAS, stale-incarnation denial after recreation, and exact PUT/DELETE
receipt replay with the originally submitted guard. These are source changes awaiting native proof.

The authorized Copy reconciliation is represented in the original Library requests: fresh positive and suspended
create attempts explicitly send `kind: 'physical'` and `status: 'owned'`. Positive deletion carries the revision
captured after the successful update, and suspended deletion carries its captured Copy revision. The profile suite's
missing-kind rejection remains unchanged. Neither transport adds a kind or refreshes a guard on a caller's behalf.
Historical kindless receipt compatibility remains owned by the
[profile consumer contract](../library-profile-consumers.md#legacy-command-compatibility-and-retirement).

The Library [fixture compiler](../../services/kernel/test/library/support/profile-entry-fixture.ts) starts with bundled
source data and explicitly declares the original progress modes/units and physical holding statuses on Book and
edition profiles. The existing driver publishes and activates that actual compiler output through Definitions HTTP
before creating Semantic subjects, and checks the subject's returned release and type. Fixture accounts now use
native handle reservation, pending registration, Auth provisioning evidence, handle claim and activation, with the
production Auth/Access binding. Positive accounts and active definitions are no longer installed by fixture SQL.

The [released profile cases](../../services/kernel/test/library/released-profile-user-cases.test.ts) remain bundled
first-public coverage, not proof of the broader custom-profile or migration suite. [Public scope](../scope.md)
closes custom catalogue publication behind platform grants; it does not exclude historic fact clearing or authorize
skipping these frozen cases. No suite is skipped here. The four additional entry points still reference absent native
driver modules; complete adapters have not been delivered. Current production dependencies prevent a complete binding:

- Shelf routes require `ShelfReads`, but [kernel composition](../../services/kernel/src/http/kernel.ts) does not supply
  it, and [createShelfReads](../../services/kernel/src/library/shelf-contract.ts) still throws for all three reads.
- The [Collection source factory](../../services/kernel/src/library/collection-source.ts) still returns
  `dependency_unavailable` for every operation. Logical built-in discovery and dynamic members are not supplied by
  the current curated [routes](../../services/kernel/src/library/collection-routes.ts).
- [Personal label commands](../../services/kernel/src/library/label-commands.ts) provide the label catalogue, but
  kernel composition mounts no label action/HTTP boundary or complete assignment command/page provider. The label
  suite also requires the same unavailable logical built-ins.
- [Legacy pin pages](../../services/kernel/src/library/profile-migration-page.ts) are a maintenance primitive, not
  the owner migration command/executor required by the original profile suite. The
  [Library work module](../../services/kernel/src/library/work-module.ts) registers no profile migration workflow,
  checkpoint/ready transition or recovery boundary.

These are production prerequisites for their existing outcomes. Supplying successful test providers, wrapping
maintenance pages in a test-side migration engine, or skipping the broader suites would violate native binding.
Runtime owner integration, complete adapters, native acceptance, regression evidence and promotion remain outstanding.

Foreground local kernel typing passed (exit `0`), including the command's construction check. The first invocation
of `env -u KERNEL_CHECK_REMOTE bun run --cwd services/kernel typecheck` unexpectedly selected the shared remote queue;
that owned invocation was cancelled before compilation. To keep compilation local, the existing
`withThrowawayDatabase` compiler lifecycle supplied `DATABASE_URL` to the same foreground command from a temporary
worktree script. No compiler substitutions or SQL typing changes were used. No acceptance, native, browser or
regression checks ran. Typing does not establish native outcome evidence; whole-suite acceptance remains required
after integration.

## External conditions

Actual direct-seller rights, Managed Payments eligibility/activation, supported production configuration,
provider bank payout setup, creator agreements/payment method and lawful financial-retention schedule remain external
and unproved. Do not wait for private setup to prove deterministic signed-event, entitlement and lifecycle fixtures.
Commercial/shared adoption of tax/unit, reserve/carry/payability, richer attestation and authenticated recovery
remains explicit in the owner contract; unknown economics cannot be silently implemented.
