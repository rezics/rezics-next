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

## Receiving lifecycle handoff

Current `useBuyerCurrentOrigin` is intentionally address-bound: its `onBeforeNavigate` subscription retires
origin and intent on every changed href, and unmount disposes both. It must retain this behavior. The existing
session BrowserObservation can identify equal successful replacement and credential/A-B/A changes, but does not
own a buyer Router visit that survives list/detail/Edition return. Neither current list exposes that retained
visit to this model. Web's buyer navigation/lifecycle owner must supply that receiving seam within the eligible
Router/QueryClient visit, without a second observer, root provider, registry or storage. The model is not wired
into production until that custody exists.

That receiver must retire both paths, callbacks and pending focus on source, session, account, credential,
admission or locale replacement and unrelated departure. Eligible same-app ordinary clicks keep their canonical
href while using router navigation; modified/new-tab clicks retain browser behavior. Keyboard focus is consumed
once on admitted heading focus, failure, independent user focus, replacement, cancellation or disposal. Existing
command departure decisions remain singular and recheck their original origin immediately before navigation.

Read before this decision: `docs/goals/web.md` buyer return outcome; `docs/commerce.md` buyer receipts;
`buyer-current-origin.tsx`; `orders-current.tsx`; `entitlements-current.tsx`; both list pages and route receivers;
`order-history-address.tsx`; `entitlement-history-address.ts`; `purchase-return.ts`; `reader-origin.ts`;
`session/observation.ts`; and the main checkout's read-only `.reference/INDEX.md`. No legacy code is ported.
