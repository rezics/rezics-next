# Commerce buyer and creator outcome quality review

Reviewed 2026-11-03 against dev `8f63aa396c789f5d6b10b5f65c2edaf24a3d5987`, also the clean
retained worker source at inspection. **Done-when clauses 1–5 remain unmeasured on this revision.**
The original native entry exists, but its offer fixture still requests a fresh subject-only sale that
the current owner contract refuses. Separate Content, Access and Commerce cases do not establish a
paid buyer's final protected read. Historical passes cannot close this gap.

The current launch instruction overrides the contract's execution request: acceptance, native,
browser, root, worker-check and remote-check runs are deferred until integration. No such command
was invoked, no check UUID or current run artifact exists, and there is no current assertion exit
to report. This report completes the research assignment; it does not make Commerce acceptance
green. Main promotion remains parked.

## Authority and evidence levels

The exact clauses below come from [Commerce Done when](../goals/commerce.md#done-when).
[Commerce's owner contract](../../services/kernel/src/commerce/README.md) owns behavior;
[the capability inventory](../goals/commerce.capabilities.md) records stages, not product authority.
All repository line anchors describe the bound dev source. Test names and source inspection below
mean declared coverage, never executed coverage.

The native entry, `services/kernel/test/commerce/outcomes.test.ts:1–4`, sets an absolute
`COMMERCE_DRIVER` and imports the unchanged `specs/commerce-outcomes.test.ts`. The specification
has 23 literal cases. The driver imports production Auth, Access, kernel, Stripe adapter and work
modules; it clones migrated PostgreSQL databases and starts its own production DBOS executor
(`support/outcome-driver.ts:1–118,143–218,307–360`). It forwards actual responses and inspects
native orders, entitlements, outbox and workflow records (`:479–528`). Its provider substitute is
the loopback `support/fake-stripe.ts`, reached through the official SDK, rather than a Commerce
model. This is the correct binding to retain, subject to the fixture defects below.

Earlier evidence is available as a **secondary historical account** in
[the integrated review](commerce-integrated-done-review.md#what-the-native-evidence-actually-proves):

- It reports main-checkout `.temp/goal/commerce/F140-native-accepted-after-direct-route.log:52–208`
  containing **23 pass, 0 fail, 562 expectations**, associated by a separate ledger with
  `47d56b806ead2a1ae342fe9c18d70433e60ab103`. The review explicitly says the log does not bind all
  executed bytes to that commit. The raw log and process exit were not inspected in this attempt.
- It reports `.temp/goal/commerce/verify-dev-commerce-bdc326a125.result.json` binding an earlier
  run to `bdc326a1255718faa861e6b66dbbfe95a9609c4c`, exit **1**. This is a historical failure,
  not a failure measured at the current base.
- Its old target-digest, public-delisting and refresh-ordering findings are not automatically
  current defects. The current capability inventory already retracts the target-digest defect;
  current HTTP and refresh cases now exist. Neither that report nor the
  [refresh research](commerce-session-refresh-recovery-deep.md) supplies current-dev execution.

No historical artifact was copied into this report's worktree. Current evidence paths are the
source and tests cited here, and this report. Current runner logs, result manifests, browser
recordings, screenshots and physical-cost measurements are absent from this attempt.

## Required clauses and bounded next proposals

These are proposals for the existing owners, not queued briefs or additional implementation.
Every clause needs current execution after integration, even where source coverage exists.

### Clause 1: complete buyer journey — missing composition and measurement

> Subject entry, offer, hosted Checkout, private purchase/owned-benefit navigation and final protected use form one
> journey through ordinary APIs, native storage and reviewed pages. The first target is an exact authored native Content edition (`content.edition`, `edition:read`, revision ID and
> SHA256). Real Content sale authority, Accounts opaque benefit facts and final Content reads must be delivered
> before protected-use completion; bounded subject discovery remains a shared delivery.

**Reproduction candidate:** C0 below. Its `provisionOffer` supplies `targetSubjectId: newId(...)`
but no `contentEditionId` (`support/outcome-driver.ts:444–460`). Current
`commands.ts:255–331` prepares `captureCurrentContentEdition(input.contentEditionId ?? '', ...)`;
`benefit.ts:108–122` rejects an invalid edition locator with `ContentEditionUnavailableError`.
Thus the driver cannot prepare the fresh positive sale required by its cases. This is a
source-derived fixture incompatibility on the base, not an observed failed run or infrastructure
incident. It must not be repaired by allowing fresh subject-only sales or returning successful
sale-authority stubs.

There is useful separate coverage: `subject-offers.test.ts:153` names bounded current positive
discovery; `acquisition.test.ts:133–141` creates/publishes a native edition and submits its ID;
`purchase-history.test.ts:37` follows paid/refunded history. However, the frozen driver interface
does not expose a protected Content read. `content/edition.test.ts:162–257` asserts exact
revision/hash/body and current ancestry denial, but explicitly installs an `edition:read` grant
before reading bytes. `commerce/content-edition-buyer-fact.test.ts:14–108` checks the real reader
using SQL-seeded entitlements. Neither is the missing paid-purchase-to-bytes journey. The bounded
search of Commerce test sources found no final `/contentEditions/:id/revision` request.

**User-visible repair outcome:** a buyer discovers the offered authored revision, pays once,
finds its captured terms and owned benefit, and reads exactly those protected bytes through the
current native buyer fact. The refunded and foreign buyer cannot use that purchase; a newer post
head never substitutes another revision. Current source/ancestor/account restrictions still deny.

**Reuse owners and bounded proposal:** Commerce owns the original driver and composed journey;
reuse Content's existing `createNativeContentSystem` fixture, immutable edition publication and
`readContentEditionSaleAuthority`, with Accounts' current benefit reader and worker authorization.
First repair only `test/commerce/support/outcome-driver.ts` and necessary fixture helpers so C0
uses authored native editions and the real account admission path. Its current account setup
directly inserts pending rows and updates them active (`:219–226`), which is not ordinary native
account activation proof. Preserve the frozen assertions. Then propose one supplemental native
paid-use case joining that fixture to final Content HTTP reads, including refund, same-route
other buyer and source loss. Likely paths: Commerce test support, Content test support, and a
Commerce journey test; production changes only for an actually reproduced binding defect.
Web owns the existing journey's recorded-response stories and 390/1280 review, separately.

### Clause 2: immutable accepted terms — declarations present, current result missing

> The one-time account-bound, one-fixed-version-benefit/quantity-one contract captures immutable accepted terms;
> historic subject-only orders remain unknown until explicitly authorized mapping. Repricing/delisting cannot edit
> a captured sale; current availability and rights remain separate.

**Cases/commands:** C0's `buyer checkout snapshots the offer at T in the buyer partition and sends
inline Stripe prices` (`specs/commerce-outcomes.test.ts:172`) captures offer revision, price,
creator, tax and royalty basis, reprices afterward and inspects actual provider parameters.
The suite's delisting and idempotency cases preserve the existing purchase. C2 supplies
`http.test.ts:735` (displayed revision conflict without a new order/provider call), `:787`
(required positive revision), `commands.test.ts:593` (authorized exact replay), and
`legacy-order-replay.test.ts:206,262` (retained receipt identity, UNKNOWN mapping and current
checkout state). C3 adds exact-benefit acquisition guards, including another offer for the same
benefit and verified release after adverse disposition.

The original driver's `Inspection` and offer DTO in `specs/commerce-driver.ts:36–105` do not
inspect the immutable edition capture. The original price case alone therefore cannot prove
edition/action/version/licence/terms immutability. `offer-revision-http.test.ts:86–95` also still
creates subject-only offers; its presence is not a fresh native-sale pass.

**User-visible repair outcome:** the precise displayed `expectedOfferRevision` and fixed
`content.edition`/`edition:read`/`{revisionId,sha256}`/quantity-one terms survive price changes,
withdrawal, retries and refunds. Historic purchases stay visibly unmapped; conflicts require
explicit new review and consent without a second charge.

**Existing owner/proposal:** reuse Commerce's consent, historical-replay and acquisition owners.
Repair their positive native fixtures where needed, then extend a supplemental capture case to
assert offer → buyer-home order → entitlement equality, SQL immutability and actual SDK request
parameters after revision/delisting. Keep C0 and the historical-replay assertions unchanged.
Likely paths: `test/commerce/support/**`, `test/commerce/offer-revision-http.test.ts`, existing
HTTP/consent/capture tests; `src/commerce/{commands,store,checkout,creation-attempt}.ts` only if
the reproduced result requires a fix. This is a missing measurement and capture-composition
gap, not evidence that current immutable guards failed.

### Clause 3: durable fulfilment — current native result missing

> Fulfilment has one durable effect: buyer-home order, entitlement and named payment evidence change atomically.
> Signed events schedule fresh bound reads; redirects, history and Library presence never authorize use.

**Cases/commands:** C0's signed paid completion, exact signed-byte replay, unpaid paid-claim,
async payment, early/full/partial refund and dispute cases; C4's command atomicity
(`commands.test.ts:329`), real workflow recovery (`checkout-workflow.test.ts:100`), signed
enqueue failure (`webhook.test.ts:197`), default work and current admission tests. C1 supplies
history/return boundaries. The original snapshot test reads provider request metadata,
inline quantity/price/tax, Managed Payments and the stable `order:<id>` key; C5 checks the
official adapter independently. No redirect or listed entitlement is final-use evidence.

**User-visible repair outcome:** a lost response, duplicate event or worker restart still leaves
one paid order, one current benefit and each named movement once, or an honest pending/unknown
state. A failed durable enqueue is retried rather than acknowledged as completed fulfilment.

**Existing owner/proposal:** reuse Commerce's default refresh/settlement work, with the existing
Core receipts/outbox and Work runtime owners if a measured defect crosses those boundaries.
After fixture repair, run C0/C4; inspect native order, entitlement, transaction, receipt/outbox
and DBOS results across the existing read-before-commit and commit-before-ack barriers. Propose
one bounded repair per actual failed boundary, keeping expected one-effect outcomes. Likely
paths: `test/commerce/{checkout-workflow,default-refresh,session-refresh-user-cases}.test.ts`,
their existing support, and `src/commerce/{commands,work,settlement}.ts` when necessary.

### Clause 4: uncertainty, replay and current eligibility — current results and operator coverage missing

> Creation uncertainty, evidence completeness, immutable movement economics and bounded signature/secret inputs
> satisfy the owner contract. Exact replays have one effect, conflicts reconcile, incomplete evidence never grants
> or restores, and terminal account fences prevent personal-benefit resurrection.

**Cases/commands:** C0 covers rejected/lost creation, signature forgery/staleness, replay and
refund/dispute states. C4 covers newer no-op admission, stable completed replay, physical death,
lost acknowledgement and default Session serialization; C5 covers complete associations,
immutable movement conflicts and transport/signature caps. C6 covers real Auth deletion and
terminal non-restoration. C7 covers buyer-authorized known-order repair, foreign same-route
denial and missing consent. `default-refresh.test.ts:35` names internal paid-order repair;
`order-reconcile.test.ts:87` is an authenticated buyer repair, not proof of a separately
authorized repair operator. Operator-specific end-to-end current evidence was not located in
the inspected bindings. A payout operator is not automatically a repair operator.

**Only accepted exceptions:** owner README `Delivery and acceptance` permits
“idempotency/mismatched-old-retry uncertainty” and “unavailable future dispute status with last
verified state preserved.” The creation section classifies Stripe idempotency errors, mismatched
old retry, in-flight conflict, cached server failure and network loss as unknown/unavailable.
Unsupported future adverse evidence cannot restore a revoked benefit or mask known blocking
evidence. No additional exception, omitted assertion or alternate backend is proposed.

**User-visible repair outcome:** uncertainty keeps the original key/parameters and visible debt;
complete current evidence alone changes access; exact movement repeats have one economic effect,
conflicts remain visible; deletion permanently fences personal grant/restoration while permitted
financial truth continues. Authorized repair targets the known order without a new charge;
foreign, unconsented and terminal callers gain neither private information nor repair authority.

**Existing owner/proposal:** reuse Commerce's existing known-order/refresh/terminal owners,
Accounts' account-share fence and Work's current runtime. First run C4–C7 through their owning
runner; preserve original assertions and report any obsolete positive fixture separately.
Then propose only the missing repair-persona binding on the existing adopted authority. The
owner contract leaves authenticated provider Event enumeration a pending port; do not invent
an operator API or sweep to fill that gap. Likely paths: `src/commerce/{order-reconcile,enqueue,
work,creation-attempt,stripe,settlement}.ts`, existing native tests/support and Accounts/Work
ports only for a reproduced owner defect. Provider send/byte/cap measurements and native/DBOS
costs must be recorded separately; constant statement counts do not prove examined-row bounds.

### Clause 5: creator economics — current results and composed view measurements missing

> Creator offer/sales/statement views distinguish historical payment, current entitlement, provider bank payout,
> attributed earnings, reserves/payability and actual external payment attestation. Remaining commercial/shared
> additions require explicit adoption before runtime bodies; accounting unknowns are visible.

**Cases/commands:** C8's creator offer/sales suites cover private creator-home reads,
same-route foreign creators, scope/principal, signed cursors, monotone copies and terminal
fences. C9's payout suites name exact statement calculations, later-month adjustments, mixed
rates/currencies, identical private 404s, mark-paid reauthorization and movement conflicts.
`money-evidence.test.ts` preserves actual presentment/settlement provenance and unknown units.
These are supporting suites: for example `payouts.test.ts:51–70` supplies a non-provider
`StripePort` and locally signs credentials; it is not full Auth/SDK buyer-to-creator acceptance.
No current combined creator-page recording/review was measured here.

The owner `Financial evidence and creator statements` explicitly separates provider cash,
historical payment, current entitlement, attributed earnings, reserves/payability and external
attestation. Existing mark-paid saves an authorized reference; it neither transfers Stripe
funds nor proves payability/external finality. Additional reserve release, negative carry,
evidence-complete payable rules and richer date/method/amount/currency attestation need adoption
before runtime changes. Sales rows do not disclose buyer identities or current entitlement;
understanding the distinction must not introduce that private data into creator views.

**User-visible repair outcome:** creators understand what was sold, what is attributed, which
amounts remain unknown/unavailable for payment, and what external payment was actually recorded,
without treating a paid purchase or provider bank payout as creator payment.

**Existing owner/proposal:** reuse Commerce's creator-sales, money-evidence and statement owners
and Web's existing view review. Bind one existing native sale/refund/dispute history to creator
offer/sales/statement API responses and their page recordings, explicitly checking the six
distinctions and foreign/anonymous denials. Separate any commercial adoption proposal from a
bounded display/binding repair. Likely paths: `test/commerce/{creator-sales,creator-offers,
payouts,payout-mark-paid,money-evidence}.test.ts`, their support and existing Commerce Web pages.
No new accounting engine or financial policy follows from this review.

## Persona inventory at the bound source

Every row's current execution result is **not measured**. Fixtures/cases below show intended
coverage, with no inferred pass from their existence.

| Persona                | Located cases/boundary                                                                                   | Missing current evidence                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Buyer                  | C0 snapshot/payment/replay; C1 history; C2 consent; C3 exact acquisition                                 | Native authored sale through paid final protected read and reviewed journey                                                         |
| Refunded buyer         | Frozen full/partial/early refund and dispute cases (`:391–470`); C4/C6                                   | Same exact protected read refused/restored only under complete current evidence                                                     |
| Same-route other buyer | Driver buyer/other both route `0x3300` (`:114–115`); frozen identical-404 case `:250`; C7 foreign repair | Current private history/benefit and final-use denial with the buyer's IDs                                                           |
| Creator/seller         | Driver's private seller uses real grants/commands; C2 seller revision; C8/C9 own views                   | A complete creator Auth/API/provider/page journey, without buyer-private disclosure                                                 |
| Other creator/seller   | C8 same-route creator scope/principal cases; C9 private statement denials                                | Current foreign offer mutation/receipt and all creator financial view denials together                                              |
| Anonymous              | Frozen public offer/private denial `:137`, webhook forgery `:337`; C1/C8/C9                              | Current subject discovery and final protected-use denial; webhook validity supplies no buyer identity                               |
| Suspended              | Frozen pre-suspension credential case `:484`; C1 credential refusal before private SQL                   | Current fresh/replay/use denials; native old bearer must return `401 invalid_credentials`, not a manufactured valid suspended token |
| Terminal               | C6 real Auth T races; C1 deleted history; C8 terminal source fences                                      | Current default late-money reconciliation with no grant/restoration/private read; not whole financial erasure certification         |
| Repair operator        | Internal known-order repair C4; buyer repair C7; payout operator C9 is distinct                          | Adopted authorized/unauthorized repair identity exercised through the real boundary; do not infer it from staff or payout authority |

## Owning commands and actual execution status

Commands below are exact repository-root invocations for the integration owner. They are an
inventory, not a new smaller acceptance definition. C0 remains the original acceptance; the
others support its Goal clauses. All have **not invoked / no process exit / no run evidence path**
in this attempt. No suite was run with skips or a replacement backend.

```sh
# C0 — original 23-case specification through its native driver
bun run --cwd services/kernel check test/commerce/outcomes.test.ts
# C1 — discovery, return, history and the two native sale/use boundaries
bun run --cwd services/kernel check test/commerce/subject-offers.test.ts test/commerce/checkout-return.test.ts test/commerce/purchase-history.test.ts test/content/edition.test.ts test/content/edition-mechanical.test.ts test/access/authenticated-benefit.test.ts test/commerce/content-edition-buyer-fact.test.ts
# C2 — accepted revision, seller mutation, receipt authorization and historical replay
bun run --cwd services/kernel check test/commerce/http.test.ts test/commerce/commands.test.ts test/commerce/offer-revision-http.test.ts test/commerce/revise-offer-target-replay.test.ts test/commerce/legacy-order-replay.test.ts
# C3 — one unresolved/owned exact benefit and verified release
bun run --cwd services/kernel check test/commerce/acquisition.test.ts
# C4 — actual workflows, default work, admission, recovery and known-order repair
bun run --cwd services/kernel check test/commerce/checkout-workflow.test.ts test/commerce/checkout-anchor.test.ts test/commerce/checkout-refresh-admission.test.ts test/commerce/session-refresh-user-cases.test.ts test/commerce/default-refresh.test.ts
# C5 — provider requests, completeness, movement integrity and bounded signed ingress
bun run --cwd services/kernel check test/commerce/stripe.test.ts test/commerce/stripe-locator.test.ts test/commerce/stripe-transport.test.ts test/commerce/stripe-caller-deadline.test.ts test/commerce/settlement.test.ts test/commerce/creation-attempt.test.ts test/commerce/webhook.test.ts test/commerce/config.test.ts
# C6 — native terminal account races and default late reconciliation
bun run --cwd services/kernel check test/commerce/terminal-benefit.test.ts test/commerce/default-refresh-terminal.test.ts
# C7 — adopted buyer known-order repair and foreign/unconsented denial
bun run --cwd services/kernel check test/commerce/order-reconcile.test.ts
# C8 — creator offer and source-backed sales privacy/currentness
bun run --cwd services/kernel check test/commerce/creator-offers.test.ts test/commerce/creator-sales.test.ts
# C9 — creator statement economics, external reference and money provenance
bun run --cwd services/kernel check test/commerce/payouts.test.ts test/commerce/payout-mark-paid.test.ts test/commerce/money-evidence.test.ts
```

`services/kernel/package.json` maps `check` to `scripts/check.ts`. Its
`placeKernelCheck` (`:842–901`) delegates through `runOnCheckHost`, propagating the actual exit;
the runner owns native dependency preparation. Keep that placement and environment. Direct
`bun test specs/commerce-outcomes.test.ts`, a fabricated `DATABASE_URL`, generated-binding edits
or forced local placement would not substitute for these runs. When integration executes them,
retain the checked source commit, full command, runner result/log paths, actual exit, per-case
and per-persona results, and whether failure precedes assertions. A queued check is still pending.

No test or workspace source was changed, so no changed-test landing command or workspace
typecheck applies to this documentation-only delivery. Native growth checks and all browser,
visual and broader acceptance evidence remain deferred. The README's unresolved locator and
combined-refresh examined-row findings (`:1013–1017`) are existing owner-recorded concerns,
not newly reproduced failures here.

## Stale capability evidence and source-state prose

Do not certify or rewrite acceptance stages from file presence. The capability inventory is
explicitly historical (`:5–7`); its `unknown` acceptance and pending promotion remain appropriate.
The following source-absence descriptions need owner reconciliation after measured acceptance:

| Historical claim                                                                                                  | Current source counterpoint; proof still missing                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offer-to-usable-benefit` says discovery transport is unapproved/missing (`:859–868`)                             | Owner now adopts `GET /v1/subjects/:id/offers` and `subject-offers.test.ts`. Full subject slot → payment → protected bytes and reviewed pages remain unmeasured.                                                                                      |
| `offer-lifecycle-and-target-receipts` says public GET tests existence and revision HTTP is absent (`:890–899`)    | `http.test.ts:306` asserts concealed delisting; `offer-revision-http.test.ts:60` and owner revision-bound seller contract exist. The latter's subject-only setup still needs repair; none is a current pass.                                          |
| Refresh helper, admission/default queues and repair producers are missing (`:180–183,921–930`)                    | Owner names `beginCheckoutRefresh`/`applyClaimedCheckoutSnapshot`; C4 declares default/recovery races; owner and C7 now define buyer reconcile. Execution and full repair-operator evidence remain open.                                              |
| README says Accounts factory/getter are absent (`:385–387`), and current Content producer is pending (`:441–445`) | `work/authorization.ts:16–55`, `work/registry.ts:78–99`, `content/edition-sale.ts` and C1 are present. Their existence does not establish paid fulfilment/final use. The repeated pending sentence at `:445–446` also needs editorial reconciliation. |
| Historical “23 native cases” might be read as current Goal completion                                             | Register counts are registrations only; the retained driver's subject-only setup is incompatible with current fresh sale. Keep unknown current acceptance until C0 and the composed supplement execute.                                               |

These are documentation reconciliation candidates for Commerce, not permission to remove
missing protected-use, interface, financial custody or physical-cost obligations. Financial
erasure is outside clauses 1–5's requested review and is not certified by terminal fence tests.

## Primary-source patterns and recommendation

Official Stripe documentation inspected on 2026-11-03 provides independent boundary guidance:

- Fulfilment must tolerate repeated/concurrent invocation and cannot depend on visiting the
  return page. This supports durable native one-effect settlement and signed-event recovery;
  it does not supply REZICS Content permission.
  [Checkout fulfilment](https://docs.stripe.com/checkout/fulfillment?ui=full-page).
- Signatures require the unmodified body. Event order is not guaranteed and duplicate delivery
  must be handled. Retain native admission/replay checks rather than event timestamps as order.
  [Webhooks](https://docs.stripe.com/webhooks).
- API v1 idempotency retains the initial result, including server errors, compares parameters,
  and permits pruning after at least 24 hours. Preserve the owner's captured parameters/key and
  conservative cutoff; uncertainty is not permission to start another payment.
  [Idempotent requests](https://docs.stripe.com/api/idempotent_requests).
- Balance activity includes pending/available funds and separate refund, reserve and payout
  movements. Order-linked cash observations cannot establish creator payability or external
  creator payment. [Balance transaction types](https://docs.stripe.com/reports/balance-transaction-types).

The reused official `stripe-node` clone is
`/home/edge/projects/rezics/rezics-next/.reference/commerce-integrated-done/stripe-node`, commit
`3af59f7c86a2350a8ea5298473f258d622bd8651` (v23.0.1), **MIT**, verified from `LICENSE`.
Source anchors:
[signature verification before parsing and age tolerance](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/Webhooks.ts#L142),
local `src/Webhooks.ts:142–176,448–506`;
[Checkout payment status separate from Session status](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/Checkout/Sessions.ts#L884),
local `src/resources/Checkout/Sessions.ts:884–888,941–944`;
and [balance economics, availability and source identity](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/BalanceTransactions.ts#L57),
local `src/resources/BalanceTransactions.ts:57–65,101–120`.
No clone code was installed, built, executed or copied. Official documentation is cited as
documentation, not assigned the SDK's MIT licence. Current kernel declares Stripe 23.1.0 and
DBOS 5.5.3-preview; this older reference is boundary research, not a claim about exact installed
SDK or DBOS execution. Earlier DBOS 5.4.6-preview research likewise needs current-version proof.

The shared pattern is separation of notification, immutable intent, observed financial state
and the final effect. Recommended for this repository's Bun/PostgreSQL/DBOS stack: retain the
original native wrapper and real Auth/Access/Content fixture composition, keep the SDK's signed
loopback provider boundary, and inspect atomic native effects and final HTTP bytes separately.
First restore the positive fixture on the adopted target; then integrate current native runs
and a small paid-use supplement. Reuse existing repair owners for actual failures. Do not copy
an upstream fulfilment example into a second entitlement or authorization engine.

Decision: preserve frozen outcomes and record clauses 1–5 as unmeasured until the owning runner
proves the repaired native fixtures and composed paid-use boundary on a recorded integration commit.
The report is the only worktree change. The authorized shared `.reference/INDEX.md` topic line
was updated to record clone reuse; no owner contract, product code or promotion proof was changed.
