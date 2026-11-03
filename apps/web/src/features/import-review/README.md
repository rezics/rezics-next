# Provider review

Web owns the complete private `/imports/review` journey, its Context-choice adapter, stories, caller fixtures and
localized wording. The first-scope audit found a raw Context UUID entry, generic scope labels and async work whose
subject-only lifetime could survive a session replacement. This surface replaces that entry with a real named
current Context and carries its human label through preparation, comparison, explicit consent and decision readback.
Semantic owns native Context and candidate authority; Imports owns registrations and acquisition. There is no
parallel Semantic UI implementation and this surface introduces no catalogue, grant, Context write or importer work.

## Choice and scope

`contexts/choice-native.ts` reuses `community/setup-context-native.ts`'s installed strict 20-row directory reader.
It adds query256/cursor4096 admission and independent generated `GET /v1/contexts/:id/lifecycle` resolution.
Directory reads always request `deleted:false`, one page per explicit Search/Next, retaining the native opaque next
even on sparse pages. A directory label never grants read or accept authority. Choosing Global is explicit and uses
the same independent lifecycle resolution. Missing labels get localized unnamed wording rather than requiring UUIDs.

The form offers Bangumi (`bangumi`), VNDB (`vndb`), Open Library (`open-library`) and Wikidata (`wikidata`), from the
[importer registration contract](../../../../../services/importer/README.md). The CLI's `openlibrary` provider option
is distinct from the default registered `open-library` alias. Other syntactically valid configured keys remain
supported exactly; no provider-directory authority is invented. Labels never replace command keys.

A submitted scope has its own monotonically retired visit. Editing source/status or choosing another Context
invalidates it synchronously, before React commits. A Context is resolved again before queue/continuation/preparation
reads. Hidden/deleted/unreadable choices clear the previous queue and selection. Each native Subject refusal conceals
that Subject independently; other rows remain useful. Comparisons retain exact current Context statements, proposal
qualifiers/references/rank/provenance and independent links. Unavailable current comparisons cannot be selected.

## Reader and command custody

`ProviderQueueJourney` observes the actual session Query and QueryClient, successful update count, Query identity,
subject and token facts. Equal successful writes, removal, sign-out, token changes, QueryClient/adapter replacement,
scope changes and unmount retire old callbacks. Ordinary invalidation/fetch/error notifications with healthy retained
data preserve useful work. Synchronous observations prevent A-B-A restoration from reviving old rendered actions.
There is no claim about unobserved credential history or a change to private first-render/SSR admission.

Mounted server adapters prepare exactly one actual Request per call and return its actual subject/token reader
envelope with private no-store. Expected headers only compare; they never authenticate or stamp provenance. Null-CSRF
healthy readers can browse. Prepare/decision/readback POSTs retain original explicit-token native authority. A reader
mismatch retires the admission and exposes explicit recovery; new work needs new private responses.

Confirmation captures the existing native immutable batch and original transport, reader/token closure, labels,
source/status, Subject, candidate, Context, operation, expected head, structured idempotency key and native session.
Current queue labels cannot rebind it. Unknown decisions reread their original exact Subject/Context/session before
queue refresh. A failed reread remains uncertain; no automatic retry, no new key and no inferred durable rollback.
Explicit retries keep the original command; native controller success classification skips confirmed successes.
Losing authority suppresses later effects without pretending to cancel an already admitted durable write. Readback
and execution finally blocks cannot unlock a replacement visit. Focus and navigation callbacks check the same visit.

## Bounds and retained verification

One explicit directory action reads at most20; no auto-refill or enumeration. Existing queue limit20, selection20,
opaque native200/202 continuations and independent bounded exact Subject/Context reads remain intact. Native queue,
controller, parser, expected-head and decision transport bodies are unchanged. The original direct exports and typed
standalone recorded seams remain compatible; standalone initial results make no private SSR fetch.

The connected assertions in `tests/provider-context-choice.test.tsx`, the additive queue/action assertions and the
named journey stories are authored **UNRUN**. They cover actual mounted server adapters/session cache, delayed work,
same-subject equal success/token/sign-out/QueryClient/scope/visit replacement and ABA, original token writes, unknown
readback, sparse pages, bounded growth and eight locales at phone390/desktop1280. Native website acceptance is
`tests/native/catalogue-provider-review.host.test.ts`. Public/browser/growth, private-SSR and visual review remain
owed after integration; source delivery and workspace typing do not prove them.
