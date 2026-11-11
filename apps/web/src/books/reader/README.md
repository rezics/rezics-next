# Hosted Book reader

`HostedBookReader` is the mounted Book reading profile of Content's shared Studio. It uses the existing
`PostReadingBody` for readable measure, outline, spoilers, references and admitted image rendering. It creates no
editor, publication lifecycle, bibliography, progress conversion or progress command. Semantic Work, Series and
Edition reading stays with the [literary catalogue reader](../../features/catalogue/literary-reader/README.md).

Decision: retain the existing reader and exact native adapter, bind installed generated Content operations, and
require explicit prepared-viewer/publication/target admission from the host. Do not manufacture that admission
from a route, a catalogue ID, an illustrative response or a cached body.

## Source and host

`source.ts` defines the consumer projection, independently of transport. Each explicit open, More, Retry or return
makes one `source.read({ address, locale, limit: 40, ancestorLimit: 24 }, signal)` observation. There is no prefetch,
refill, per-row hydration or descendant download. A contents level retains its supplied order and distinguishes
containers, bodies, combined container/body rows and unavailable slots. Empty or sparse windows may continue.
Opaque continuations replace the window; failed pages retry the exact parent/cursor/selection.

A publication has a catalogue ID, frozen source structure revision and (for native reads) a separate publication
release revision. A chapter selects a stable occurrence plus exact Post ID, revision and SHA-256. Reused bytes have
separate occurrence addresses. No title, ordinal, semantic relation, scalar progress value or current Post head
creates that selection. The page separately reports current release/structure context, actual ancestors and
bounded previous/next observations. Known publication ends and unavailable navigation have distinct presentation.

The installed `native-api.ts` calls the generated `KernelClient.hostedCatalogues` catalogue, children, occurrence
and navigation operations directly. Its response types derive from those operations. Runtime schemas validate
external responses; exact canonical bytes are decoded and digest-checked before the existing Document validator.
The [Content owner](../../../../../services/kernel/src/content/hosted-chapters.md) owns native disclosure, immutable
release selectors, unavailable slots, cursor binding and size limits. The adapter neither synthesizes endpoints
nor falls back to Web's development fixture transport.

`NativeHostedBookReader` mounts that adapter through the private `readNativeHostedBook` server function. Each call
prepares the real session, compares its anonymous/session subject against the host's expected viewer, carries
native credentials, and uses private/no-store responses. Expected browser identity only narrows native admission;
it cannot grant access. Missing credentials, origin or installed host admission remain explicit unavailable states.
The host also supplies the publication title: the installed Content catalogue metadata has no title field.

The host supplies a stable `NativeHostedBookAdmissionSource` object for one admission incarnation:

```ts
const admitted = {
  state: 'current' as const,
  publication: { id: catalogueId, releaseRevisionId, structureRevisionId },
  currentReleaseRevisionId,
  currentStructureRevisionId,
  publicationTitle,
  viewer: { kind: 'session' as const, subject: preparedSubject },
};
// Host-owned native observations, not values parsed from an untrusted route:
const admission = { getSnapshot: () => admitted, subscribe: observeAdmissionReplacement };
// <NativeHostedBookReader address={exactChapterAddress} admission={admission} />
```

Publication/current-structure admission, target access and prepared-viewer replacement must replace the snapshot
object and notify synchronously, including equal-value and A/B/A replacement. Replacements cannot recycle an old
snapshot. `HostedBookSource` has the same incarnation rule. Source/session/address/locale/viewer retirement removes
bodies, rows, return coordinates, pending requests and late focus effects. Transport cancellation is advisory;
queued dispatch, completion and focus also check their original visit. Deliberate reopen rereads the active exact
address, never the host's earlier initial chapter or a retained payload. Replacing the host visit discards that
reopen address, including A/B/A replacement.

Native reading observes both frozen and current releases, resolves the selected exact body and current occurrence,
reads only its bounded ancestor path, and requests at most one neighbour in each direction. It rechecks both
release observations before disclosure. Native target admission still belongs to each Content read; these separate
operations do not constitute a cross-request native transaction. Current context uses the current public release,
not a private Studio draft. Children and neighbours retain the selected frozen release. After a move, an old
contents window can therefore show a moved-selection notice and an exact return even when that occurrence is
outside the window. A current parent absent from the frozen release can be unavailable; no body or tree is substituted.

## Return, controls and progress

Opening a chapter retains only its bounded contents coordinates and exact selection. Returning rereads that
window through the current source; old rows and body are discarded before dispatch. Sparse continuation and failure
keep the same opaque position. An admitted moved selection retains its exact chapter address. An unavailable
selection never silently chooses a replacement body.

`hrefForAddress`, when supplied by the host, maps typed addresses to real origin-local canonical links. Modified
activation keeps ordinary browser behavior. Without that binding the reader exposes in-place buttons and invents
no Content URL. The eventual host owns route/history integration and canonical deep-link parsing.

Explicit navigation focuses the new heading; contents return focuses the selected occurrence when present,
otherwise its heading. Moving focus elsewhere during the request cancels the transfer. Arrow navigation is scoped
to the reading region, mirrors the document's direction, and leaves text selection, editable/interactive controls,
modifiers, held keys and input methods alone. The controls wrap, have 44px targets and can be pinned on phone or
desktop. Document language and direction remain independent of interface locale.

An optional `renderProgress(page, isCurrent)` mounts the region admitted and implemented by the existing Commerce
progress/resume owner. That owner retains reads, commands, retries and uncertain outcomes. A rendering failure is
isolated from the readable chapter. No region is invented when that producer is absent.

## Cost

### Explicit chapter or contents observation

- Touches: one source read; for the native binding, one BFF observation with catalogue/release checks, bounded
  children or exact selection, ancestor resolves and at most two one-neighbour navigation reads.
- Bound: one retained contents window of at most 40 rows (native maximum 20), or one decoded chapter, at most 24
  ancestors, two neighbours and one return address. Native requests are at most `7 + ancestors + changedRelease`
  for a chapter, or `5 + parentProbe + ancestors + selectedResolves` for contents; both are at most 32. Each native
  operation keeps its own Content bounds. Native body bytes are at most 2 MiB per resolution; an exact/current
  selection may resolve two bodies. Consumer cursors allow 8,192 characters; native cursors allow 4,096. No pages,
  tree index, body cache or cursor chain accumulate.
- Growth check: mounted assertions pin source-read count and operands, and illustrative transport assertions pin
  native limit/selector use. They are not native growth evidence. Native cost and admission acceptance remain with
  integration and the Content owner.

## Stories, assertions and remaining integration

`illustrative-source.ts` supplies labelled native-format examples through the actual native mapper, never the
production transport. `stories/hosted-book-reader.stories.tsx` mounts the actual reader. The story ID prefix is
`interfaces-hosted-book-reader`; named states are `nested-contents`, `exact-chapter`, `sparse-continuation`,
`failed-page-recovery`, `moved-occurrence`, `unavailable-navigation` and `retired-reading`. Review the same states at
390px and 1280px, light/dark, with all eight locale globals: en, zh-Hant, zh-Hans, ja, ko, de, fr and es.

`tests/hosted-book-reader.test.tsx` authors mounted assertions for nested bounded reads, reused bodies, exact
operands, sparse continuation/retry, deliberate return, moved context, RTL/selection/editable keys, focus retirement,
source/viewer/session/locale replacement, independent progress failure and the generated native transport.
Execution belongs to the dev verifier: `bun run --cwd apps/web test tests/hosted-book-reader.test.tsx`.
Source acceptance requires the final Web workspace typecheck. Neither stories nor typing establish native/browser
acceptance. The production host admission producer, canonical router binding and Commerce-supplied region remain
integration work; there is no installed Studio/reader route supplying those observations in this source tree.

The design uses [Web's launch owner](../../../../../docs/goals/web.md), the catalogue reader above,
[Threads](../../threads/README.md), [history lifetime](../../threads/post-history-lifetime.md),
[session lifetime](../../session/README.md), [Document](../../../../../packages/document/README.md),
[UI](../../../../../packages/ui/README.md) and [verification](../../../../../docs/development/verification.md).
The read-only `legacy-final:apps/web/features/work-page/reader.tsx` and `reader-client.tsx` comparison retains
supplied part/chapter context, readable body, contents return, mirrored keyboard navigation and phone controls.
Stable occurrence/exact-revision selection improves on ordinal reading links; legacy scalar progress is not ported.
