# Current Realm claim review

## Installed operations

The approver uses generated `KernelClient.realms({ realmId }).claimRequests.get` with `limit: 20` and an
unchanged opaque `cursor`. The installed producer also accepts `inspectRequestId` on this same operation. Its
`selectedRequest` is a reviewer-qualified exact observation, independent of the pending page and its continuation.
The generated community route declaration reflects the delivered route schema. No requester-owned status endpoint
is used for approval review.

Rows contain the original request/account identifiers, `orphanedAt`, `claimEligibleAt`, `requestedAt`, native
`claimant: { label, href }` and `approvalAdvice`. The latter names the installed POST destination, Global
`realm:approve_claim` and `Idempotency-Key`. Web validates that advice against the existing generated approval method;
it never follows an arbitrary command destination. Neither dates, Realm roles nor transport success authorize a grant.

`realmPresentation` is either admitted name/description or `unavailable`. Missing context does not conceal an otherwise
admitted queue. Concealed or erased claimant identities use the producer's safe label with no profile link; Web never
looks up individual accounts. Identity history, eligibility, succession and producer growth remain Content/Accounts
responsibilities. Source examples live in `services/kernel/src/community/realm-claim-review.ts` and native assertions
in `services/kernel/test/community/realm-claim-review.test.ts`; Web fixtures are consumer compositions, not native proof.

Decision: legacy queue source factories remain display-only without advice; real transport responses require every
installed current-review field, and only an exact pending observation can create an approval intent.

## One page and one selection

One explicit continuation reads one raw page, including empty-plus-next. Retry preserves its exact cursor; typed
`invalid_cursor` and `stale_cursor` stay distinct and permit explicit first-page restart. There is no refill or search.
Prepare performs a separate `inspectRequestId` read without the queue cursor. It binds request, claimant and original
episode before confirmation, retains the current queue page and never treats a row in the returned page as inspection.
The immutable intent retains its native observation, source and original command key. Approval still uses only the
existing generated `.$approve.post`; the command performs current native authorization and succession checks.

## Uncertain outcomes and lifetime

An unavailable approval reply preserves the original intent and key. Inspect original request is read-only and cannot
replace or erase that intent, produce a receipt, generate a key or replay the command. A separate recovery button is
available only after an admitted inspection. It sends the original command/key, even if the selected pending row has
left the queue. An approved observation remains distinct from a committed command receipt. A validated native receipt
remains visible while the first-page readback is pending or unavailable; current refusal conceals private facts.

The existing caller lifetime binds the Realm, actor/session generation and original CSRF token. Departure Stay retains
the intent; Leave retires callers synchronously, conceals private facts and fences late effects without cancelling
native work or replaying it. No intent transfers to another session. See `realm-claim-callers.md`.

Requester status remains a separately authorized generated `mine.get` or exact requester receipt read. Legitimate mine
absence, denied exact missing, pending/approved and historical `currentEpisode` retain their existing meanings. An old
approved receipt after re-orphaning never requests ownership in the new episode or implies a current grant.
