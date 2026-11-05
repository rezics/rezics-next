# Notification driver publication binding

The notification outcome adapter binds [Done-when 6](../goals/content.md#done-when) through native authenticated
authoring and registered delivery. Its method signatures remain those of
[the frozen driver contract](../../specs/content-notification-driver.ts).

| Driver operation | Native operation                    | Binding                                                                                                                            |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `createThread`   | `POST /v1/threads`                  | Forward the supplied opening visibility; preserve the opening post's native revision ID.                                           |
| `createPost`     | `POST /v1/threads/:id/posts`        | Forward the supplied post visibility and parent; preserve the native revision ID.                                                  |
| `revise`         | `POST /v1/posts/:id/revisions`      | Forward the supplied visibility and the input post snapshot's revision ID as quoted `If-Match`; preserve the returned revision ID. |
| `readPost`       | `GET /v1/posts/:id`                 | Preserve the current native revision ID.                                                                                           |
| `effects`        | Registered notification effect host | Drain or replay committed outbox envelopes through production relays and notice effects.                                           |

The expected head belongs to the input snapshot. Fetching a newer head would conceal stale writes and change
idempotent replay semantics. A successful replay retains its original revision even after a newer head exists.
Revision IDs come from native responses, including thread openings; the adapter has no version counter.

The native producer emits `com.rezics.content.post.published.v1` once, with the first published `revisionId`.
Creation and revision events carry no notice authority. The shared reply fixture in the retained source
`d0324db88a8baa56fcf717be7aaa52c302b06d46` already selects that publication event; its previously reported creation
event selection is superseded. The adapter in that source drops post/revision visibility and revision identity,
and omits revision `If-Match`.

[The focused regression](../../services/kernel/test/content/publication-driver.test.ts) exercises the adapter
using its existing native Auth fixture and registered host. It delays creation delivery until draft A has
published B and advanced to C, compares mapped revision IDs against original HTTP responses, rejects a stale
snapshot, and replays the original publication request. Inbox assertions require B's mention and the opening
author's reply, with no mention to A or C. Controls cover immediate publication, silent drafts and later edits,
replay stability, current membership and preferences. No publication event is manufactured and no selected
visibility is rewritten by the regression.

These are authored native regressions, not a measured acceptance result. Controller admission owns the full
notification/reply/mention acceptance after integration; no proof registration or promotion follows from this binding.
