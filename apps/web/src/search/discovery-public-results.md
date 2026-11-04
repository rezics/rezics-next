# Public Search result rows

The mixed result list admits one complete native page before rendering any row. Every hit has a closed summary kind and
the full `{ owner, kind, route, id }` key; summary identity must match the key, and each summary kind must match its
owner and native kind. React identity uses that whole key, so equal UUIDs from different owners, routes or kinds remain
separate results in native order.

The current public row shapes are intentionally small:

| Native key             | Current supplied summary                                                                                   | Canonical destination                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `library / collection` | `id`, `title`, nullable `description`, native cover/count/presentation, curator and bounded member preview | `/{locale}/collections/{id}`                                                                |
| `content / review`     | thread `id`, `kind: review`, nullable `title`, optional current author, excerpt and reviewed Subject       | `/{locale}/threads/{id}/{title-slug}` (the ID route uses `thread` when the title is absent) |
| `community / space`    | `id`, `title`, current `address`, optional summary and Realm title                                         | `/{locale}/spaces/{address}`                                                                |

Decision: Search UI uses `library/collection`, `content/review`, and `community/space` public result tags, and
derives canonical local links from the admitted full key and current owner summary; absent optional text stays absent.

The public row adapter performs no reads, federation, sorting, deduplication or count calculation. It renders only supplied
public titles, descriptions, excerpts, reviewed-Subject context, Space address and Realm title. Collection rules,
private membership or facts, review votes, and Realm rank figures are not accepted by the closed public summary schemas.
Missing current summaries or addresses make the whole page unavailable rather than producing a partial row or preview.

## Work discriminators

Decision: Label supplied facts with the existing released property's localized name, preserving its exact item target
and date precision; absent role metadata never makes a contributor an author or an unqualified date a release event.

Search already supplies figures, aliases, descriptions, four selected fact properties (three values each), release
list presentation, and Character/Person context. The result family keeps those features and its four-visible-fact cap.
The existing definition metadata supplies property names without another request. A name is limited to 96 code points;
each property is named once in the fact preview, and the selected date keeps its own property name and precision.
The exact localized Subject title link remains the destination for additional facts. There are no new response fields,
sorts, context caches, private overlays or per-hit reads. Search's existing reader and request retirement still governs
the entire page, including these labels.

The optional native `workContext` is owned by [Search](../../../../services/kernel/src/search/README.md#qualified-work-context-in-discovery-v1)
and [Semantic](../../../../services/kernel/src/semantic/README.md#qualified-list-work-context). Admission validates
its closed shape independently of generic facts: exact subject/Type/source identity, unique statement IDs across
categories, outgoing property role, revision, definition release, rank, asserted original and terminal item identity,
same-statement qualifiers, exact signed decimal strings and partial Gregorian dates. MusicAlbum remains a work.
An absent field, an empty section, withheld context, unsupported context and each unavailable reason remain distinct.
Withheld sections retain no identities or counts. Qualifiers never migrate between credits. Generic facts retain
their independent four-visible-value presentation, property labels, date precision and item destinations.

Each category contains at most three statements and each statement at most four qualifiers. Terms select at most
one label language at 256 UTF-8 bytes. Admission validates the actual 16,384-byte hit and 262,144-byte page totals,
including unavailable envelopes, before displaying any rows. A disclosed fourth statement sets passive overflow;
it publishes no continuation destination. The receiver never crawls, hydrates or refills a Subject.

Decision: qualified context uses the existing ResultRow metadata/control layer and exact localized Subject links;
overflow is passive text, and the existing validated Search `via` return now accepts Global as well as Realm Search,
retaining the original query/filter/language/layout/cursor bytes and the result-region fragment.

The generated callable is an independent activation requirement. `work-context/availability.ts` checks its activation
literal against the real `KernelClient.subjects.$search` return type. Until the retained root publisher installs the
qualified discovery response and generated work-context declarations, native context admission remains bounded but
production displays native-unavailable context. The standalone supplied-context story is a presentation preview,
not installed callable or rendered integration acceptance. No generated declaration, wire DTO or producer is supplied
by Web. Normal publication must be followed by receiving type reconciliation and production activation.

The existing Search query and personal host share public entry currentness. Successful cache replacement retires
an earlier entry even if structural sharing keeps the same data object. Address changes retire selected callbacks;
the existing host cache subscription also retires reader/credential transitions, including A/B/A, before selection.
Exact failed-cursor Retry retains its address. This public observation neither settles an uncertain personal command
nor changes its original credentials, revision, body or operands.

The retained default Search path includes ready Collection, review and Space producers in the shared kind
directory and current-page guard. Collection rows include native public curator/member context; their private
follow advice uses the mounted current-reader seam described below. These source changes
do not establish native growth or browser acceptance evidence. Subject and Account rows keep their existing summaries
and routes.

## Controlled personal actions

Decision: The controlled Search entry interface keeps admitted facts unchanged during commands, treats a lost or
unavailable native reply as uncertain, and coalesces successful or uncertain overlapping writes into one page refresh.

The general mixed Search host now mounts the controlled entry form and native score view. Release-search and
concept-browse retain their own hosts. Collection, Review, Space and Account actions stay with their native owners.
The public loader remains public: a mounted signed-in reader obtains a private, no-store POST assembly, never a
private query-cache entry, URL parameter or public summary field. Share, reload and Back assemble current server facts.

Decision: Capability metadata exceeding one shared 1 MiB/1,024-chunk transport allowance withholds affected inline writes;
only the immutable standard Global question enables score writes, and conditional providers remain unavailable.

A single page-level capability projection uses the current authenticated release and operation exposure, separately
from entry existence. Released states preserve their labels and order; missing profiles are unsupported, concealed
operations are concealed, and failed metadata is unavailable. Unknown session, signed-out session, unsupported,
concealed and unavailable outcomes have separate messages in all eight locales. No Subject is loaded for a row.
The private envelope carries each original row's resolved Subject from the already prepared native identity batch.

`discovery-personal-state.ts` owns immutable admitted observations independently of suppressed display state.
`discovery-personal-actions.ts` builds native entry commands with revision/incarnation and explicit question-bound
score commands, including zero and absence. The reusable native score transport uses the existing vote PUT/DELETE
port; its optional observation header is verified by that writer on every prepared native attempt, before receipt
disclosure and execution. Conditional providers fail at `atomic_guard_unavailable` before any unlocked preflight.
Both native BFF adapters prepare the session and compare its reader and CSRF credential after the session await;
the native server still authorizes every command. The Library adapter's unavailable reply is conservatively uncertain.

Every action binds viewer, credential, locale, complete row, original/resolved Subject, question revision/scale,
request/page owner, registry/generation and capability/exposure observations. Observed retirement is terminal,
including an A → B → A cache transition. The registry persists for the QueryClient across page incarnations and
serializes each native entry or question/vote identity without queues. Independent entry/vote writes already sent
settle before one refresh. Pending, rejected, uncertain, successful and retired states remain distinct. Rejection
retains facts/drafts; success or uncertainty suppresses the entire private assembly without altering its observation,
then refreshes once. Late writes and reads cannot publish or roll back into another reader, request or locale.

The host preserves query, filters, ordering, expanded contexts and URL. Pending controls retain their DOM focus;
refresh adopts authoritative drafts for every duplicate. On disappearance it focuses the next surviving row, then
the restart action or result region, with preventScroll and the captured scroll position. Cancellation retains focus
when its control survives and uses the same fallback when it disappears. A focus moved outside the result region
is respected. Obsolete reads are aborted; native writes already dispatched are awaited rather than retried.

### Finite work per page assembly and command settlement

Let `P(L)` be the installed retained native page cost in
[the discovery query contract](../../../../services/kernel/src/search/discovery-query.md#complete-page-work-and-retained-state), with
`L <= 100`, `R <= min(600, 6L + 3)`, three raw windows, `H <= L` mixed hits, `S <= H` Subjects and eight kind rows.
It includes both ordered raw presentation batches, both public-figure batches, one private prepare/read/final-check
lifecycle and the retained finish/close guards. Duplicates, rejection and empty lookahead consume the original raw
allowance. There is no added per-row read, pool checkout or retry.

Each private web assembly performs at most three session preparations (initial, after capabilities, after the native
page), three metadata GETs (active release, exact release, exposure) sharing 1,048,576 bytes and 1,024 stream chunks,
and one `P(L)`. Capability projection visits at most `S` kinds. The combined serialized private rows and capabilities
must fit 65,536 UTF-8 bytes; ordered original inputs retain the native 100/16,384-byte bounds. The controlled target
snapshot independently enforces 100 originals/16,384 input bytes/65,536 evidence bytes, including repeated question
observations. An oversized snapshot withholds all private facts and controls, retaining admitted public hits.

A public initial load plus private bootstrap plus one mutation reconciliation therefore costs at most three `P(L)`,
six metadata GETs/2 MiB/2,048 chunks and six session preparations, plus the existing one session/exposure observer.
No native command hydrates a row. Each user entry action sends at most one native write, one conflict reload and
one removal undo-credential lookup through the existing owner adapter; each score action sends one native vote
write and no unbound question read. With `U <= S` distinct native identities, pending work is at most `2U <= 200`
independent entry/vote commands; each has its native finite command/transaction bounds. Competing duplicates and
retired actions add zero writes. Known rejection permits a new explicit user action, never an automatic retry.
Successful/uncertain overlapping settlement adds exactly one private assembly. Empty/final pages use the same
final authority check. A false viewer check retires the whole page without restart retry; ordinary producer failure
retains the independently admitted public page. Cleanup aborts at most one assembly and disposes one page/registry
subscription per incarnation; it starts no replacement read or continuation protocol.

## Collection curator context and following

Decision: Collection previews show three admitted members from a four-occurrence native prefix, with explicit empty,
withheld, partial, truncated and unavailable states; follow state stays in the private page envelope.

Curator links use only the currently admitted handle destination. Deidentified/withheld attribution never falls back
to an index label. Member links address actual Subjects and retain each member Type; Collection cover, presentation,
public occurrence count and canonical destination retain their existing meaning. All eight locales label context and
preview states. Ordinary links preserve the browser's Search history, query and continuation.

The mounted personal Search host consumes aggregate `collectionFollows`, checks its account and full source binding,
and feeds Library's existing `FollowControl`. The adapter makes no per-row GET. It passes explicit reader/credential
evidence to a no-store BFF and reuses Library's idempotent native follow writer. A confirmed reply refreshes the local
edge from the command result; a failed/uncertain reply retires that row's aggregate edge and exposes accessible failure
feedback. Pending never renders following success. Other rows and the cursor stay admitted. The existing permanent
session/exposure/credential/request/locale/source lifetime guard rejects delayed replies even after A → B → A.

The three personal Search files additionally include this envelope in the existing private byte allowance and suppress
it when the private page lifetime is unavailable; public cards never receive viewer facts. Browser and native broader
acceptance remains deferred to integration.
Space rows consume current native presentation and reader-bound `spaceEntries` from the aggregate;
they issue no detail requests. Native community identity, Space address/summary and carried-Realm
context remain separate. Avatar absence, withheld media and unavailable/loading-failed media have
explicit fallbacks. Standalone Spaces are named as standalone. A carried Realm always uses the
admitted Realm destination, with current entry and rules/admission advice separate from following.
No carrier is inferred from labels or an address, and no Global destination is substituted.

Decision: Space following consumes Library’s shared native observation adapter, with exact source
bindings and a final currentness check; unavailable observations retain explicit unavailable advice.
Allowed commands call the existing Library Space-follow writer with a final
expected-reader/credential fence. They never join a Realm. The mounted Search lifetime shares the
existing no-queue command registry, announces pending/failure, and performs one aggregate refresh
after settled successful or uncertain commands. Known rejection keeps the current row. Refresh
failure keeps public presentation with private advice unavailable. Reader, credential, locale,
request and exposure retirement discard delayed writes and out-of-order reads. Query, filters,
scope, layout, continuation, focus and scroll remain in the Search visit; native entry/rules links
use normal navigation so browser return restores the original URL. All advice is localized in the
eight supported locales.
