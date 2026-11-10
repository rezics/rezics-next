# Native order publisher restoration prerequisite

Goal: accounts
Manager: supermanager

Root coordinates the Access/Content publisher action prerequisite. Keep
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

## Received Realm adapter and final owner handoff

`d78f6c41-fff1-41f0-bcfa-011ea151e378`,
`339124d7-72c5-4ab3-b81f-a8706472dd9f` and
`78dd5deb-30b8-4801-bebc-11618eda808d` each passed kernel compiler and selected
quality checks, then failed the same native pre-grant order assertion: expected
404, received 503 `dependency_unavailable`, `retryable: true`,
`effect_status: not_applied`. The latter two used temporary diagnostics around
native Content restoration and Access preparation respectively. Neither logged
an exception during that first failing HTTP operation. The earlier subsequent
direct-port exceptions therefore do not establish that operation's cause. All
temporary diagnostics were removed; native request, authority and assertion
remain intact.

Received exactly the accepted Realm adapter source `c243a7a5f7` by cherry-pick,
which preserves native permission evidence instead of replacing it with an empty
Realm proof. The only additional product path is
`services/kernel/src/http/kernel.ts`.

`66eee6c9-d645-4f9d-b395-7661627fe47f`, source `bb5e84ca5a`: complete kernel
compiler and selected lint/format passed, including the received adapter and all
three changed TypeScript fixture/test files. The affected order case still
failed at its first pre-grant `POST /v1/orders`: expected 404, received 503
`dependency_unavailable`, `retryable: true`, `effect_status: not_applied`,
request ID `01a1c5dc-3405-773a-a888-59772e9a9e3a`. Result: 0 pass, 1 fail,
2 unchanged readiness cases filtered out. Checkout and retained-order success
remain unreached. Concurrent Discovery physical-incarnation errors and account
agent contention do not classify this native assertion as infrastructure-only.

Keep this continuation and stop fixture expansion and unchanged selector reruns.
Root will keep the order witness separate and compare it only after the owner's
new publisher action repair has verified proof. No producer absence or exact
first-503 cause is inferred from the generic availability response. Documentation
updates after this result change no executable source; reuse its compiler and
quality evidence, retaining the failed order result as failed.

## Remaining producer and receiving check

The native Access/Content publisher action repair must first have verified owner
proof under the existing current-role, consent and finite-deadline contracts.
Receive that owner prerequisite without introducing another Access engine, mock facts,
broader grants, a public source or increased deadlines. The exact first-503 cause remains unverified; do not choose a broader fixture
repair from the later direct-port restoration exceptions.

Then run only `terminal erasure order prerequisite` through the owning kernel
runner. Keep native pre-grant 404 and post-grant 201, and preserve actual buyer
authority. The exact-grant success, provider request, buyer readback and stored
buyer/seller/revision assertions are unreached and unverified. Full terminal
erasure, broader acceptance/native/browser/root/growth suites remain deferred.
The earlier Source contention has its own producer scope; do not use this order
prerequisite to diagnose it.
