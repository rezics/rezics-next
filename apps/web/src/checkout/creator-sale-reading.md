# Creator sale reading

The existing `/creator/sales` visit reads the current creator's native page through
`useCreatorCurrentOrigin` and `readCreatorSalesCurrent`. It admits at most twenty sales and preserves the opaque
cursor, including its existing 4096 UTF-16-code-unit bound. The captured title retains its existing 1024-unit
bound. Opening an inspection, copying a reference and preparing destinations add no requests.

The list keeps the recognizable captured title, exact recorded price and currency, tax meaning, settlement and
ordered time. Inspect sale focuses the reading heading. The selected reading exposes the full wrapping title,
exact amount, raw integer, captured money-unit precision, tax meaning, distinct settlement explanation, exact
recorded timestamp and labeled sale, offer and work references. Unknown money units show amount unavailable and
the stored integer; they never borrow today's currency precision. The amount is a charged unit price, not a
revenue total or payout. Pending, failed and unknown payment observations cannot establish earnings.

Escape or Close returns focus to the surviving initiating button without changing the address. Copy includes the
localized Sale reference label; missing or refused clipboard access offers selectable text and reports failure.
A reference is not an export, receipt or permission to read the buyer's order. Copy success belongs only to the
still-open selection that initiated it, including when the same sale is closed and reopened.

## Lifetime and cost

Build one O(N) identity index per admitted page/address/source, N <= 20, referencing the existing page rows.
Selection and lookup are O(1); the renderer inspects just one row. Retain only the current page and one selected
identity with opaque source/selection tokens. Do not accumulate pages or store private sale data in browser storage,
URL search parameters, fragments or history state. Index preparation adds no reads, enrichment or preview calls.

Decision: every replacement observation retires selection; browser return uses the existing sales address and a
fresh admitted owner reading rather than restoring a private inspection snapshot.

Locale, requested cursor, account, exposure or read replacement retires inspection and all pending clipboard
results synchronously. Even an equal-ID response is a fresh observation. Current Query data disables structural
sharing for this purpose. Stale handlers cannot reopen a replaced source, navigate its destinations or publish copy
feedback. Authorization remains exclusively with the existing origin; preparation, loading and refusal cannot
retain an old reading. A native partial projection may contain supplied rows and its preparing notice; that
projection state does not imply authorization preparation or completeness.

Explicit refresh and page links alone request sales. The native `next` remains opaque. A stale cursor offers a
restart; empty first and continuation pages remain distinct, and a preparing projection never asserts zero sales.

## Destinations and ownership

Only UUID-validated `offerId` and `targetSubjectId` become links. The offer uses the ordinary localized public
offer reader; the work uses the canonical Subject overview helper with an unavailable-label slug, never an inferred
work kind, current work title or benefit. Each reader applies its own availability and admission. A retired or
unreadable destination does not change the recorded sale or guarantee a current price. Standard anchors and browser
Back preserve the sales address/cursor; no private metadata or arbitrary return URL enters the public destination.
The sale's `orderId` stays a sale reference and never becomes a buyer-only order link.

Creator Offers and Royalty Statements remain adjacent navigation. Statements have independent period and line
authority. No delivered relation associates a sale with a specific statement, and a paid purchase never proves
creator payout. Commerce retains offer, sales, settlement and payout contracts; buyer entitlement and payment
controls keep their existing owners. This visit introduces no new native method, statement join, financial engine,
refund command or aggregate.

Constructed Creator Sales stories cover the supplied states and interactive reading loop. They do not establish
native execution, browser geometry, authorization or runtime acceptance; integration owns those checks.
