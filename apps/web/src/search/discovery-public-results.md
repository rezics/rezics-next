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

The retained default Search path now includes ready Collection, review and Space producers in the shared kind
directory and current-page guard. Collection, review and Space rows use the closed public variants above; private
Library overlays and owner-specific richer card contexts remain a separate current-reader seam. These source changes
do not establish native growth or browser acceptance evidence. Subject and Account rows keep their existing summaries
and routes.

## Controlled personal actions

Decision: The controlled Search entry interface keeps admitted facts unchanged during commands, treats a lost or
unavailable native reply as uncertain, and coalesces successful or uncertain overlapping writes into one page refresh.

`discovery-personal-state.ts` provides the page lifetime and a shared native-identity command registry;
`discovery-personal-actions.ts` constructs the existing Library entry commands, including incarnation and revision;
`discovery-personal-controls.tsx` renders the controlled entry form. These are reusable building blocks, not yet wired
to the live Search host. No component loads a Subject, manufactures writable profile evidence or grants permission.
The host must supply released profile choices, separate operation exposure, current session authority and a native
current-reader command adapter. The existing boolean rating adapter is insufficient for explicit question-bound writes;
score controls must wait for the guarded native adapter rather than use that adapter as a substitute.

The host supplies immutable admitted targets and an imperative current observation. That observation must disappear
on session or exposure retirement, and change with the viewer, credential, locale, request, page, registry, generation,
row identity, resolved Subject, entry revision or question. An observed retirement is terminal even if old props return.
Retiring the displayed private facts after a command retains this separate authority observation only until the single
refresh settles; it does not authorize another dispatch. The registry persists across page incarnations, refuses
competing writes without queuing them, and separates entry and vote identities. Refresh waits for every already
dispatched command on the retiring page, so a second command cannot complete behind its refreshed facts.

The controlled seam admits at most 100 ordered targets, 16,384 UTF-8 bytes of original `{rowKey,subjectId}` inputs and
65,536 bytes of target evidence. It adds zero native reads before a command and at most one post-command page read.
`readDiscoveryMutationPage` uses the existing page endpoint and its final admission lifecycle with cancellation and no
automatic rating restart. The host must still account for the future bounded capability read, native commands and
complete endpoint costs before enabling this interface. Production wiring, question-bound score commands, focus on
result disappearance/restart and native acceptance remain continuation work.
