# Public Search result rows

The mixed result list admits one complete native page before rendering any row. Every hit has a closed summary kind and
the full `{ owner, kind, route, id }` key; summary identity must match the key, and each summary kind must match its
owner and native kind. React identity uses that whole key, so equal UUIDs from different owners, routes or kinds remain
separate results in native order.

The current public row shapes are intentionally small:

| Native key | Current supplied summary | Canonical destination |
| --- | --- | --- |
| `library / collection` | `id`, `title`, nullable `description` | `/{locale}/collections/{id}` |
| `content / review` | thread `id`, `kind: review`, nullable `title`, optional current author, excerpt and reviewed Subject | `/{locale}/threads/{id}/{title-slug}` (the ID route uses `thread` when the title is absent) |
| `community / space` | `id`, `title`, current `address`, optional summary and Realm title | `/{locale}/spaces/{address}` |

Decision: Search UI uses `library/collection`, `content/review`, and the pending `community/space` source tags, and
derives canonical local links from the admitted full key and current owner summary; absent optional text stays absent.

The row adapter performs no reads, federation, sorting, deduplication or count calculation. It renders only supplied
public titles, descriptions, excerpts, reviewed-Subject context, Space address and Realm title. Collection rules,
private membership or facts, review votes, and Realm rank figures are not accepted by the closed public summary schemas.
Missing current summaries or addresses make the whole page unavailable rather than producing a partial row or preview.

The retained Search producer on this base still registers only Subject and Account. Until the Collection, review and
Space producers and current hydration are installed, native readiness remains unavailable; these UI contracts and
focused presentation fixtures do not establish producer or native acceptance evidence. Subject and Account rows keep
their existing summaries and routes.
