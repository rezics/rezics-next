# Buyer history navigation

Decision: stage coordinate-only intent and commit predecessors after the exact current-reader ready response;
retain the existing address-bound buyer origin and leave cross-route visit custody with its lifecycle owner.

`BuyerHistoryWindows` is the bounded receiving model, not a session observer or an authorization source. One
instance has two independent paths. Each keeps at most eight admitted predecessor cursors, a current cursor and
one exact staged target. Null means the first window; undefined means no admitted coordinate. Cursors retain
raw JavaScript string identity. The existing address parser owns the 4096-code-unit external-input grammar.
No body, title, amount, receipt, grant, credential or authorization is retained. Work and retained coordinates
are O(8) per movement; native ordering and twenty-row reads remain unchanged.

A direct later entry admits only that coordinate. Next appends the former current coordinate after success;
Previous pops only after success; First clears predecessors only after the successful first-window read.
A new Next after Previous abandons the forward branch. Failure leaves the identical staged ticket available
for Retry. Cancellation consumes the ticket. Retirement clears both paths and permanently rejects old tickets,
including delayed successes and equal/A-B/A replacement callbacks. No automatic read, replay or prefetch occurs.

The production receiver must bind each ticket to the exact current viewer, operation, locale and requested raw
cursor. Orders must receive its matching current-reader result, not loader preparation or cached data.
Entitlements additionally requires `page.kind === 'ready'`. Preparing, denied, unavailable and cursor-error do
not admit a ticket. Native malformed/stale recovery remains explicit. Call `admitEntry` only after a successful
current first or direct-entry reading; a URL alone never establishes admission.

`PurchaseHistoryPosition` and `purchaseHistoryHref` remain the sole paired URL projection. Each list changes
only its own cursor. Receipt/entitlement identity and the supplying fixed Edition origin retain their existing
owners. This model neither settles uncertain commands nor changes payment or current Content Access meaning.

## Production receiving lifecycle

Decision: `BuyerHistoryVisit` carries only the two coordinate paths in the existing Router/QueryClient composition;
current readers receive their exact ready responses and each address-bound `BuyerCurrentOrigin` still retires.
The root's existing lifecycle mounts the carrier without another provider. It receives the checkout-declared current-visit capability from the session producer, which subscribes narrowly
to the installed BrowserObservation, including equal-success and A/B/A transitions before React publication.
Exposure replacement, locale replacement, unrelated departure and composition disposal clear both paths and focus.
There is no second session observer, registry, global archive or storage. Private readers retain one current body.

Canonical buyer links retain normal modified/new-tab behavior. An ordinary same-app click after the originating
control's admitted departure decision uses the existing router; it does not invoke another command decision.
List controls resolve their canonical href after staging and recheck the original buyer origin immediately before navigation.
List/detail/Edition return keeps coordinates only. Browser list loaders defer to the existing current reader in
this composition, so deliberate movement makes one bounded read, with no loader admission, replay or prefetch.
A successful direct coordinate change admits a new path without inferred predecessors. Malformed/stale First
recovery stages First when a path exists and admits it only after the matching successful first-window read.
Failed movements retain their exact ticket for the reader's explicit Retry. Non-ready entitlement pages cannot commit.

Only a focused keyboard-initiated movement can transfer focus to the admitted current heading, once. Failure,
independent focus/input, replacement, cancellation and disposal consume that pending focus. Empty terminal pages
retain Previous and First. Actions wrap with a 44px minimum height; ready/error states announce their result.
Existing receipt/Edition departure custody, current admission, no-store/noindex and command settlement remain owned
by their existing readers. Synthetic typed consumer fixtures repair old recording shapes without amending recorded
money evidence. Native, compiler, installed browser and original paired-journey acceptance remain integration work.

Read before this decision: `docs/goals/web.md` buyer return outcome; `docs/commerce.md` buyer receipts;
`buyer-current-origin.tsx`; `orders-current.tsx`; `entitlements-current.tsx`; both list pages and route receivers;
`order-history-address.tsx`; `entitlement-history-address.ts`; `purchase-return.ts`; `reader-origin.ts`;
`session/observation.ts`; and the main checkout's read-only `.reference/INDEX.md`. No legacy code is ported.
