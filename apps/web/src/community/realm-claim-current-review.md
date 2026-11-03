# Current Realm claim review

## Installed operations

The approver queue uses the generated `KernelClient.realms({ realmId }).claimRequests.get` operation. Its installed
page contains `realmId`, `requestId`, `claimantAccountId`, `state: 'pending'`, `orphanedAt`, `claimEligibleAt`,
`requestedAt` and `next`. Web requests a page of 20 and keeps the opaque continuation unchanged. Native queue admission
and disclosure remain bound to current Global `realm:approve_claim`; the browser's dates and visible Realm role do not
authorize approval.

Requester status uses generated `claimRequests.mine.get` for the current receipt or
`claimRequests({ requestId }).get` for the exact receipt. Both are requester-owned reads. `mine` may return
`claimRequest: null` for legitimate absence; exact missing remains denied. A receipt's `currentEpisode` distinguishes
its original orphan episode from today's Realm state. An approved old receipt remains an historical outcome after
re-orphaning and never creates a new pending request.

The existing generated `.$approve.post` remains the only Web approval command. It takes the confirmed Realm and request
with the original idempotency key; its receipt identifies the claimant account and records the original orphan and
approval times. The native command rechecks current Global authority. A role, member row, ordinary Realm read or elapsed
browser time does not grant that authority.

## Bounded unavailable seam

The installed generated review page does not include a display-safe claimant identity, optional Realm title or
destination, reviewer-qualified exact selected-request observation, or current native action advice. The generated
exact status read is for the claimant and cannot be reused for approver inspection. Web retains the current bounded
ID/date queue and its existing approval controller; it does not fabricate these missing fields, look up each claimant,
or treat ordinary Realm context as private disclosure. Current identity, context, reviewer inspection, advice and
successor eligibility remain unavailable until Content publishes their exact typed operations and response examples.

The generated list reports `invalid_cursor` and `stale_cursor` as native cursor failures. A same-input retry preserves
the signed cursor; either typed cursor failure can restart from the first page. The queue never refills or searches
historical episodes.

## Remaining outcome

Current-claimant recognition, optional admitted context, reviewer-qualified exact inspection and installed advice are
not yet complete. The selected exact review must bind to the original request and orphan episode before the existing
native approval can be presented. Unknown approval recovery still needs a read-only exact inspection followed by a
separate deliberate recovery action, while preserving the original intent, actor credentials and key through caller
retirement. The eight-locale current review, interaction stories, and 1/10/20 consumer growth composition also remain
open. Native eligibility, identity and succession remain Content/Accounts evidence.
