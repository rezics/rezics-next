# Inbox

Inbox reads the signed-in account's private `GET /v1/accounts/{accountId}/notifications` page. The native response is
the disclosure boundary: each closed item supplies its current actor and target state, owner summary, allowed open
identity, one-item mark-seen identity and unread state. The Web page uses a default limit of 20 and carries the opaque
continuation unchanged. A malformed or unknown item fails the whole page. Empty pages may still offer continuation.

The browser performs no actor or target hydration for an Inbox page. It uses owner summaries instead of fetching post
bodies. Withheld actors are shown neutrally and withheld target titles or IDs are not rendered. A reporter outcome may
still open its admitted report-status destination with withheld target context. Open actions use only the supported
native identity and existing localized route builders; supplied URLs are never executed.
When native disclosure names both a thread and a board, the row shows both current titles while opening only the
admitted thread-post destination.

Reading the page or opening a destination does not acknowledge notices. A chosen unread notice has an explicit
keyboard-reachable action which acknowledges only that notice. The existing bulk action still acknowledges through
the latest loaded notice. Each command uses its original account, identity and idempotency key for an explicit retry;
an uncertain result does not change unread rows or subtract from the badge. The badge preserves the native basis,
capped state and disclosure witness, and lower bounds are labelled as lower bounds.

Inbox links to `/settings#notifications` for supported preferences. The thread watch toggle remains on its existing
thread page; board subscription management remains in the existing Settings Watches section.

**Decision:** Page reads and target navigation never imply acknowledgement; only the selected-item command or the
existing explicit bulk frontier may mark notices read.

**Decision:** Notice details use a private `/inbox/notice` child route keyed by `noticeId`; it carries the current opaque cursor and all/unread selection back to Inbox, which reloads that range before rendering.

**Cost:** Each Inbox page dispatches one private list request for at most 20 items and zero actor/target requests. A
successful continuation replaces the prior page, so the view retains at most 20 notices; during a pending or failed
continuation it retains only the prior 20-row window. A chosen or bulk acknowledgement dispatches one native command,
followed by the existing deliberate badge/list invalidation. Sequential visits release the previous page and callbacks;
the browser growth check varies unrelated list size and visits while checking request, retained-row and materialized-byte
bounds. Native database and Access history growth are owned by Content, not inferred from browser requests.
