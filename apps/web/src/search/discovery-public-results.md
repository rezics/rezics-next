# Public Search result rows

The mixed result list admits one complete native page before rendering any row. Every hit has a closed summary kind and
the full `{ owner, kind, route, id }` key; summary identity must match the key, and each summary kind must match its
owner and native kind. React identity uses that whole key, so equal UUIDs from different owners, routes or kinds remain
separate results in native order.

The current public row shapes are intentionally small:

| Native key             | Current supplied summary                                                                             | Canonical destination                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `library / collection` | `id`, `title`, nullable `description`                                                                | `/{locale}/collections/{id}`                                                                |
| `content / review`     | thread `id`, `kind: review`, nullable `title`, optional current author, excerpt and reviewed Subject | `/{locale}/threads/{id}/{title-slug}` (the ID route uses `thread` when the title is absent) |
| `community / space`    | `id`, `title`, current `address`, optional summary and Realm title                                   | `/{locale}/spaces/{address}`                                                                |

Decision: Search UI uses `library/collection`, `content/review`, and `community/space` public result tags, and
derives canonical local links from the admitted full key and current owner summary; absent optional text stays absent.

The row adapter performs no reads, federation, sorting, deduplication or count calculation. It renders only supplied
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

The **qualified work-context seam is unavailable** on the current native contract. `search/hits.ts:Fact` carries only
item, calendar date, quantity and code values. It cannot distinguish empty from withheld credits, represent explicit
unknown/no-value dates, or carry detailed roles, credited-as wording, directed associations or overflow destinations.
`discovery-http.ts` exposes only Character/Person `contexts`; Web cannot treat those as work credits or synthesize
new wire fields. Native facts remain useful without claiming that missing context is empty or concealed.

Search owns the producer handoff through its existing bounded discovery page, with Semantic retaining fact meaning:
publish the smallest qualified creator/release projection with exact property/role, disclosed target identity and labels,
directed work-versus-release association, original date precision/value state, explicit empty/withheld/unavailable state,
and an admitted destination for overflow. Keep native order, match identity and currentness, with finite row/page budgets.
The receiver must then add the qualified multi-kind navigation/return and retirement acceptance; it must not hydrate
Subjects to work around this missing native projection.

The retained default Search path now includes ready Collection, review and Space producers in the shared kind
directory and current-page guard. Collection, review and Space rows use the closed public variants above; private
Library overlays and owner-specific richer card contexts remain a separate current-reader seam. These source changes
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

Space rows consume current native presentation and reader-bound `spaceEntries` from the aggregate;
they issue no detail requests. Native community identity, Space address/summary and carried-Realm
context remain separate. Avatar absence, withheld media and unavailable/loading-failed media have
explicit fallbacks. Standalone Spaces are named as standalone. A carried Realm always uses the
admitted Realm destination, with current entry and rules/admission advice separate from following.
No carrier is inferred from labels or an address, and no Global destination is substituted.

Decision: absent the shared Library follow-discovery producer, signed-in follow controls show
unavailable; the consumer seam can mount exact current following and allowed/disabled advice when
the owner supplies it. Allowed commands call the existing Library Space-follow writer with a final
expected-reader/credential fence. They never join a Realm. The mounted Search lifetime shares the
existing no-queue command registry, announces pending/failure, and performs one aggregate refresh
after settled successful or uncertain commands. Known rejection keeps the current row. Refresh
failure keeps public presentation with private advice unavailable. Reader, credential, locale,
request and exposure retirement discard delayed writes and out-of-order reads. Query, filters,
scope, layout, continuation, focus and scroll remain in the Search visit; native entry/rules links
use normal navigation so browser return restores the original URL. All advice is localized in the
eight supported locales.
