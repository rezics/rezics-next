# My classification assessments

`/library/classification-assessments` is the localized private personal destination for Content's
`classification_ballot.own_page`, mounted at `GET /v1/me/classification-assessments`. My ratings and the Subject
assessment owner stay separate. This inventory describes currently retained assessments, never complete history
or Library membership. The route adds a personal navigation contribution under the native `personal_library`
exposure. Its metadata contains only the generic localized title and excludes indexing.

## Native boundary

The source contract is `ClassificationBallotOwnPageSchema` in
[`classification-ballot-own-page-schemas.ts`](../../../../../services/kernel/src/rating/classification-ballot-own-page-schemas.ts).
The mounted reader is `createClassificationBallotOwnPageReader.page` in
[`classification-ballot-own-page.ts`](../../../../../services/kernel/src/rating/classification-ballot-own-page.ts).
The producer's populated, empty, concealed, read-only, binding mismatch, revoked, continuation and idempotent
clear examples are in
[`classification-ballot-own-page.test.ts`](../../../../../services/kernel/test/rating/classification-ballot-own-page.test.ts).
Source presence does not establish generated publication or native verification.

The installed public Client at declaration head `52c39d796113bf237a7472b2a40958330122e88d` publishes
`me['classification-assessments'].get` and the exact association `assessment.get/put/delete` methods.
`native.ts` derives page, body and readback types from those methods; it does not extend the Client or reconstruct
the older Subject writer's qualifiers. `actions.ts` prepares the current session and delegates to that adapter.
Responses use `private, no-store`; an unavailable session or origin cannot supply rows. Installed typing is checked
with the Web workspace typecheck; native execution and recorded presentation remain separate controller checks.

Available rows retain their original Subject/association keys even when the disclosed summary has moved. The
source union admits only minimal own-state for withheld rows, with no hydration, navigation or reconstructed
operands. The inspector preserves release, revision and native digests without inventing qualifier text. It shows
published native aggregate counts including zero, excludes suppressed counts and keeps provider observations
absent when the native page omits them. Native order and raw cursors survive sparse pages and selected promotion;
duplicate keys, mismatched association operands and oversized pages are rejected rather than repaired.

Decision: a browser-safe validator mirrors the closed native source union and rejects the whole page on unknown
fields or malformed context before presentation; successful validation preserves the supplied row identities and
does not grant account or command admission. Aggregate observations must retain the original association key.

Decision: disclosed Subject/Concept links use the existing localized Subject helper with a neutral slug so private
labels never enter browser URLs. Only native disclosed identities supply those links; native API hrefs are ignored.

## Private visit and exact commands

The mounted reader composes the existing private reader/current-origin, address observer and departure controls.
Every browser admission reads its exact raw frontier again, including both selected operands; loader feedback alone
never admits rows. Account, credential/CSRF observation, exposure, locale, address and source replacement retire the
visit. Abort signals and generation guards reject late reads and commands. Return starts a fresh admission.

Decision: the route loader retains session preparation only, so router caches never accumulate private native rows;
the mounted browser admission performs the single exact inventory read.

The selected editor follows native `actions.state`, set, clear and readback advice. A visible binding mismatch offers
no Clear; withheld withdrawal requires the producer's actual withdrawal advice and the native writer's preparation.
Revoked SET scope cannot become withdrawal authority. Read-only and concealed rows never infer permission from a
public summary. A selected off-page row uses its original pair; current summaries never rebind the ballot slot.

Decision: credential fingerprints keep bearer material on the server while rejecting replacement episodes before
dispatch; an unknown request retains its original CSRF token, credential fingerprint, method, exact path, serialized
body, precondition and idempotency key until explicit retry or visit retirement.

The shared command-intent owner supplies command keys. Explicit retry replays the same frozen intent; separate
current readback cannot acknowledge that intent, including an absent or opposite current ballot. Malformed readback
stays unavailable. Acknowledged, stale or denied commands require fresh exact page inspection before another edit.
Unknown commands keep new edits locked. Changing the selected record or private visit destroys drafts and intent.

Decision: unsent drafts and uncertain commands protect departure; settled commands remain locked for fresh inspection
but do not count as unsaved work, and confirmed Leave retires the current reader before route admission.

## Cost

- **Touches:** one prepared native page read per mounted admission, explicit next/retry or return; one deliberately
  selected native command and a separately requested exact readback. The transport bounds response bytes before
  public-client JSON materialization. No polling, per-row hydration, accumulation, sorting, searching or refill.
- **Bound:** native raw page 20 plus at most one selected promotion, cursor 4096 characters, at most one selected
  editor/intent and no retained page history. Native identity/type/property bounds are 256 characters, label 2000,
  release 128, href 128 and digests 64. The producer and source presentation cap serialized UTF-8 response bytes at
  1,048,576; the presentation validates the closed native union, including absent, suppressed and published aggregates.
  Revision and generation strings remain native positive decimals within that total byte cap. The adapter validates this closed source union before browser admission and binds the current account, credential
  episode and native response observation separately.
- **Growth check:** vary 1/10/20 raw rows, optional selected row 21, and bounded labels; the authored regression
  preserves exact order and original keys. Indexing and presentation are O(N), and selection uses one exact-pair
  lookup. One HTTP request is not constant native work. Native physical rows, authorization, nested Semantic
  disclosure and producer growth evidence remain producer/controller obligations.

Storybook supplies ready, preparing, empty, sparse, concealed, binding-mismatch, read-only, selected off-page,
uncertain withdrawal and long-label states with the existing locale/theme controls and 390/1280 viewports. Supplied
command adapters illustrate interactions; native recorded responses and browser/keyboard/screen-reader execution
remain controller verification, separate from these authored examples.
