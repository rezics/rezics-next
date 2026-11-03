# Saved-query results

Ordinary saved dynamic Collections use the existing Collection address and Dynamic Collection reader. Membership
comes from the common `GET /v1/collections/{id}/members` Source; the browser does not scan the Library or invent
rows. Unique canonical subjects keep per-member Type presentation and subject links. Occurrence notes, occurrence
IDs, member counts and Collection timestamps stay omitted. The saved predicate never appears on this page.

Owner-only `RuleEditLink` opens `/collections/{id}/rule` when the signed-in viewer is the curator and the identity
is not a built-in. Public and other readers receive only already-published permitted membership. They never receive
the owner predicate or a private fact-derived evaluation. Native Collection GET concealment still hides a private
unknown identity.

## Members status

| Response | Reader |
| --- | --- |
| `202 {preparing:true}` with `Retry-After` | Preparing. Retry the same validated URL and opaque cursor, `private, no-store`. At most three automatic retries, then an explicit reload of that same request. Never treated as empty success. |
| `200 {members, next}` | Ready page. `members: []` and `next: null` is a genuine empty final page. A later empty page is page-local absence with first-page recovery. |
| `503` Problem, no cursor | Unavailable. Distinct from empty. Retry the same address; missing execution stays unavailable. |
| `409 stale_cursor` | Restart once at the first page of the same Collection, filter and sort. Surface that restart and keep a first-page link that drops only the members cursor from the admitted `f.`/`r.`/`l.`/type protocol. |

Filter and `id` sort stay on the saved rule and the current URL protocol. Changing filters drops the old cursor.
Commerce owns evaluation, admission, publication and native disclosure. This page binds Collection GET plus the
members statuses above. Remaining producer work: complete saved-source execution, explicit Publication for
public/unlisted membership, and the generated dynamic Collection DTO.

Decision: reuse the installed Dynamic Collection reader and members GET; do not fork a second members runtime.
