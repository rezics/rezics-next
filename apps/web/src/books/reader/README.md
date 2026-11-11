# Hosted Book reader

`HostedBookReader` mounts the hosted Book profile of Content's shared Studio. It renders a supplied chapter title,
actual ancestor/part context, exact Post body and bounded native previous/next observations. Semantic Work, Series
and Edition bibliography remain with the catalogue. This component creates no editing or publication lifecycle.

## Source boundary

`source.ts` owns a consumer projection seam, not an installed Content API. The default source reports
`not-installed`, makes no native call and displays the localized preparation state. Supply a `HostedBookSource`
and the host's `readingIdentity` to use the actual reader independently. The source must prepare its real viewer,
admit the publication and every current structure/target read, and return only that admitted projection. Browser
identity comparison cannot authorize a native request. All eight launch locales have control and recovery messages.

A publication address contains its publication ID and frozen structure revision. A chapter additionally names a
stable authored occurrence and the exact Post ID, revision ID and hash. Reusing the same body under two occurrences
produces two addresses. Current context has its own supplied `currentStructureRevisionId`; a move can replace the
ancestors and current contents location without rewriting the exact body selection. No ordinal, title, scalar
progress value, semantic relation or current Post head is converted into an occurrence or revision.

`read({address, locale, limit: 40, ancestorLimit: 24}, signal)` is one bounded observation. A chapter response includes
its exact document, current ancestor context, contents address and both navigation observations. A contents response
includes only the requested parent/cursor window. Container, body, combined container/body and unavailable rows
stay distinct, in supplied order. A container opens its own bounded level; it never expands by fetching descendants.
The source supplies a complete root-to-parent path, at most 24 entries; it must report unavailable rather than
silently truncate a deeper path. The frozen publication, current context and selected exact body require coherent
native admission; the Web seam does not join independent unauthenticated reads to manufacture one.

Each explicit open, More, Retry or return makes one source read. Empty and sparse windows can carry an opaque
continuation of up to 8,192 characters. More replaces the current window rather than accumulating pages; Retry
repeats the failed parent/cursor/selection exactly. Known publication ends, unavailable neighbours and the end of
one contents level have different presentation. An unavailable continuation retries the supplied current window;
it cannot be treated as a known end. There is no prefetch, tree index, per-row read, refill or speculative neighbour.

Only one page is retained: at most 40 contents rows or one exact document, plus at most 24 ancestors, two navigation
observations and one contents return address. Work is linear in those supplied rows/ancestors and the existing
document renderer's body work. Titles and bodies remain subject to their producer's own size bounds. Repeated
requests do not grow retained windows or history. A returning chapter keeps only publication, occurrence, exact
body and bounded contents coordinates; the previous rows/body are discarded. The current source rereads on return.
A selected occurrence outside the returned window can be reported as `moved`, with separately admitted current
contents coordinates; an inaccessible selected target is `unavailable`, with no replacement body selected for it.

`getSnapshot()` returns a stable `BookSourceObservation` object for exactly one native admission incarnation.
Publication/current-structure admission, target access, prepared viewer or source replacement must replace that
object and notify `subscribe` synchronously, including equal-value replacement and A/B/A transitions. Source
replacements must not recycle an old observation. The store retires bodies, rows, requests, return coordinates and
late focus effects irreversibly. The mounted reader also retires through the existing session-cache observer and
address/locale visit capability. A retired reading offers deliberate reopening through the current source.
Transport cancellation is advisory; queued calls, completions and focus work separately check their original visit.

`hrefForAddress`, when installed, maps the same exact typed addresses to real origin-local canonical links. Without
that binding the reader exposes in-place opening controls. It constructs no hypothetical Content route, and has
no endpoint discovery or fallback transport. Modified link activation retains ordinary browser behaviour when a
canonical address is supplied. In-place navigation does not mutate the host router; route/history integration
belongs to the eventual host binding.

## Documents, focus and progress

The existing `PostReadingBody` supplies the readable measure, document outline, spoiler and reference behaviour,
wide content inspection and admitted image renderer. Supplied document language/direction are independent of the
interface locale. The navigation controls wrap at phone widths, keep 44-pixel targets and can be pinned while
reading. Arrow navigation is scoped to the focused reading region and mirrors RTL. Selection, input methods,
modifiers, held keys and editable/interactive controls keep their normal behaviour.

Explicit opening focuses the resulting heading; contents return focuses the selected occurrence when present and
otherwise the heading. Focus movement during the request cancels that transfer. A late result cannot move focus
in a replaced visit. Source/session retirement removes the selected body even when its bytes are equal.

An optional `renderProgress(page, isCurrent)` mounts a region already admitted and implemented by the existing
Commerce progress/resume owner. It receives the exact chapter and current-reading guard. Its owner retains reads,
commands, retries and uncertain outcomes. A rendering failure is isolated from the readable chapter. No supplied
region means no invented progress control; this reader writes no progress and performs no scalar conversion.

## Illustrative observations and integration

The adjacent stories mount the actual reader with explicitly labelled illustrative projections of this seam.
They are not generated endpoint recordings or native admission evidence. For example, two native occurrence rows
may select the same exact body:

```ts
const body = { postId: 'post-7', revisionId: 'revision-3', sha256: '3'.repeat(64) };
const first = { kind: 'chapter', publication, selection: { occurrenceId: 'placement-a', body } };
const reused = { kind: 'chapter', publication, selection: { occurrenceId: 'placement-b', body } };
// A bounded request contains one of these exact operands; it does not request a current Post head.
source.read({ address: first, locale: 'en', limit: 40, ancestorLimit: 24 }, signal);
```

The source checkpoint did not install a generated hosted Content operation for publication/occurrence/exact-body
reading. The remaining production binding must map that operation and its prepared-viewer/current-admission
observations to this seam, attach real canonical destinations and mount it in its native host. Commerce supplies
its existing admitted region when available. Those bindings cannot be inferred from routes or hand-authored DTOs.
Focused mounted assertions, final-source typing, native parity, browser/theme/locale review and publication remain
integration work. This code-only sprint runs no checks and authors no new tests.
