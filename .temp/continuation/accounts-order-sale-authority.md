# Native order publisher restoration prerequisite

Goal: accounts
Manager: supermanager

Root coordinates the Access/Content publisher-restoration prerequisite. Keep
the buyer/native offer binding, controlled Checkout composition and exact-offer
grant. Do not replace native authority, change schemas, widen permissions or
rerun the full terminal-erasure witness to diagnose this prerequisite.

## Delivered

The driver reads the actual native offer as Alice, uses its exact revision for
order creation, and grants only `order:create` on Bob's exact offer. The fixture
owns the existing loopback Stripe adapter, native Commerce work and Checkout
composition, including cleanup. Both original sellers and all erasure
assertions remain intact. The focused readiness test asserts revisionless offer
creation, actual buyer read, pre-grant denial, exact-grant order creation,
buyer readback, persisted buyer/seller/revision and one controlled Checkout.

Sources read before design: the assignment; `docs/goals/accounts.capabilities.md`;
the main checkout's `.reference/INDEX.md`; the Commerce owner README and native
Edition fixture; native offer read/create and order contracts; the three assigned
TypeScript files and their callers. Subsequent bounded diagnosis read the kernel
and test-kernel composition, the public Content sale ports and the native
current-authority acceptance composition.

## Retained evidence

`ed3ae2ec-18eb-495f-be28-77e38800baf6`: kernel compiler and selected quality
checks passed. Revisionless creation and Alice's native offer read reached order
admission; pre-grant order denial was 503 instead of 404.

`6f1ab3c7-b3fa-4e96-9992-8d2aa995f13d`: kernel compiler and selected quality
checks passed. All three readiness cases failed. Order denial was
`503 dependency_unavailable`, `effect_status: not_applied`. The existing Source
cases independently failed with `CommandUnavailableError` contention. These are
separate failures, not evidence of the same cause or passing base tests.

`8ff2088c-8751-4123-bc1d-7e167894347e`: transient diagnostic code had TS2353
and TS7031 errors, subsequently repaired. The direct buyer sale port returned
null in this run; the combined Edition/Source case passed, while the existing
activation/Source case failed with `Command unavailable for partition 806:
contention`. Do not generalize that buyer result across later runs.

`8e7f6092-32e5-448e-8695-155637d63bf6`: kernel compiler, lint and formatting
passed. The affected order case failed and the runner's isolated rerun also
failed. The first failing HTTP operation remained the pre-grant native
`POST /v1/orders`, expected 404, received 503 with `dependency_unavailable`,
`retryable: true`, `effect_status: not_applied`. After that refusal, both direct
Content ports, buyer sale and mechanical publisher sale, threw
`AccessUnavailableError: Access unavailable: overloaded` from
`content/edition-sale-native.ts:177`, where native publisher restoration converts
`DurableInitiatorUnavailableError`. The exact failed restoration suboperation
is not exposed by that conversion and remains unverified. Temporary direct-port
diagnostics were removed after retaining this evidence; the native denial probe
and its response-body diagnostic remain.

This fixture uses the function factory in `testKernel` and
`createKernelAccessResolver`; that resolver installs
`contentEditionBuyerFactReader`. Commerce's separate prebuilt-Access omission
does not establish this fixture's cause. Native current-consent is also mounted.
Do not remove either authority dependency or infer missing grants from a 503.

OpenSearch `resource_already_exists_exception`, Discovery incarnation errors,
and check-ref cleanup timeouts occurred concurrently. The wrapper did not
classify the order failure as infrastructure-only; those errors do not explain
the failing assertion. Full logs are `.temp/check-logs/<check UUID>.log`.

## Remaining producer and receiving check

The native Access/Content producer must restore Bob's original Edition publisher
under the existing current-role, consent and finite-deadline contracts. Repair
that owner prerequisite without introducing another Access engine, mock facts,
broader grants, a public source or increased deadlines. The producer's exact
restoration failure needs owner evidence before choosing a repair.

Then run only `terminal erasure order prerequisite` through the owning kernel
runner. Keep native pre-grant 404 and post-grant 201, and preserve actual buyer
authority. The exact-grant success, provider request, buyer readback and stored
buyer/seller/revision assertions are unreached and unverified. Full terminal
erasure, broader acceptance/native/browser/root/growth suites remain deferred.
The earlier Source contention has its own producer scope; do not use this order
prerequisite to diagnose it.
