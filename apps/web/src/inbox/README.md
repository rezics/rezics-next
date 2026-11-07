# Inbox

Inbox reads the signed-in account's private `GET /v1/accounts/{accountId}/notifications` page. The native response is
the disclosure boundary: each closed item supplies its current actor and target state, owner summary, allowed open
identity, one-item mark-seen identity and unread state. The reader sends All or Unread selection with the page size;
the opaque cursor binds that selection, the current viewer, client/authn currentness and page size. A selection change
restarts without a cursor. The page returns the current viewer, applied selection and owner-admitted page actions, so
the browser does not invent mark-through authority from its loaded array. The Web page uses a default limit of 20 and
carries the opaque continuation unchanged. A malformed or unknown item fails the whole page. Empty pages may still offer
continuation. A sparse page is neither an empty Inbox nor an exhausted unread range.

The browser performs no actor or target hydration for an Inbox page. It uses owner summaries instead of fetching post
bodies. Withheld actors are shown neutrally and withheld target titles or IDs are not rendered. A reporter outcome may
still open its admitted report-status destination with withheld target context. Open actions use only the supported
native identity and Content's public `threadLocation` on `thread-reading-context`; supplied URLs are never executed.
When native disclosure names both a thread and a board, the row shows both current titles while opening only the
admitted thread-post destination.

Unread-count returns are private, `no-store` and scoped to the immutable current viewer. Concurrent count consumers
for that viewer episode share one coalesced native count query, independently of page and acknowledgement custody.

Reading the page or opening a destination does not acknowledge notices. A chosen unread notice has an explicit
keyboard-reachable action which acknowledges only that notice. The existing bulk action still acknowledges through
the owner-supplied displayed boundary when the page admits it. Each command uses its original account, identity and
idempotency key for an explicit retry; an uncertain result does not change unread rows or subtract from the badge. The badge preserves the native basis,
capped state and disclosure witness, and lower bounds are labelled as lower bounds. The Inbox page shows the same
viewer-scoped native summary and a deliberate retry when that read fails. A valid Retry-After is stored once as an
absolute wait on the current viewer; expiry enables that retry and does not fetch. Count, page and acknowledgement
waits stay independent. A failed or zero summary does not hide the loaded page or invent mark-seen authority.

Inbox links to `/settings#notifications` for supported preferences. The thread watch toggle remains on its existing
thread page; board subscription management remains in the existing Settings Watches section.

**Decision:** Inbox publishes the same Library consumer port and adapter as Settings so the web-performance/web-library pair has one typed Collection/Shelf contract. Inbox pages do not mount Collection privacy or Shelf editors; `/settings` composition binds `adapters/library.ts` and `adapters/library-view.tsx`.

**Decision:** Page reads and target navigation never imply acknowledgement; only the selected-item command or the
owner-admitted displayed boundary may mark notices read. Unread continuation does not admit bulk mark-through.

**Decision:** Native All/Unread selection is the Inbox page identity. Duplicate notice IDs on one page keep native order
and the latest details; a successful page replaces the retained window rather than accumulating earlier rows.

**Decision:** Count Retry-After is observed once as an absolute deadline on the current Inbox viewer; expiry enables
the page retry control and does not schedule a fetch. The shell badge stays a compact unknown-or-count indicator.

**Decision:** Unread-count setup failures return a private, serializable unavailable result at the server-function
boundary. Truncated native coverage retains lower-bound counts from zero through 100; non-truncated capping at 100
keeps the `current-visible-unread` basis.

**Decision:** A validated native acknowledgement is consumed even when later page or unread-count refresh fails. Those
failed observations are current-read recovery with a deliberate reload. They do not reopen the original command or
label the last loaded notices as a current page.

**Decision:** Inbox list and detail share one local actor presenter for available, withheld and system labels and
identity fallbacks. The closed native actor includes an additive avatar summary with `avatarUrl: null`; presentation
keeps owner labels and never treats a stored profile URL as admitted media.

**Decision:** Inbox decodes Content’s closed actor including that additive avatar summary, keeps presentation on owner
labels, coalesces one count per viewer episode, and records installed `thread_watch` for phone and desktop return.

**Decision:** After return, a notice absent from the freshly admitted selected page is reported at the Inbox heading;
only a deliberate first-page refresh recovers, and no neighbor receives restored focus or acknowledgement.

**Decision:** Inbox consumes Content's public `threadLocation`; destination cases stay on the existing inbox-read,
inbox-native-triage, inbox-notice-detail and notifications-inbox suites.

**Decision:** Pin this journey with the existing inbox-read, inbox-page, inbox-native-triage, inbox-notice-detail,
inbox-session-authority, inbox-pagination, notifications-inbox and recorded-responses suites plus the consumption
stories and native-notifications.host; landing is those tests with changed-workspace typing. Fewest tests: keep those
suites, complete the native fixture/journey, and add one browser-work pin at 64/512/4096 rather than a second suite.

**Decision:** Native All/Unread, lower-bound badge, one-item and admitted-range acknowledgement, keyboard return,
unknown-command recovery, failed observation after receipt, and viewer/credential replacement stay on those suites.
The decoder is the capture path for current actor, thread/board titles and additive avatar summaries. Native SQL
examined rows stay with Content `growth-notice-inbox`; composed Inbox reports request, retained-row and cursor-byte
bounds and links that producer evidence.

**Cost:** Each Inbox page dispatches one private list request for at most 20 items and zero actor/target requests. Next,
Previous and browser return each issue a fresh native page read at the selected exact address; a query admission ID
prevents an earlier cached response from substituting for that read. Pagination retains at most eight prior addresses,
each paired with All/Unread and its mounted viewer episode, plus one current address and one return receipt. The native
cursor bound is 4,096 UTF-16 code units: those ten retained cursors contribute at most 80 KiB of cursor payload;
selection, episode and native notice-key metadata are fixed-size. At most one 20-row response body is readable,
including during a pending or transiently failed direction; the eight prior bodies are never retained. A successful
continuation replaces the prior page, so the view retains at most 20 notices; during a pending or failed continuation
it retains only the prior 20-row window. Concurrent unread-count consumers for one viewer episode share one coalesced
native observation, independently of the selected page. A chosen or bulk acknowledgement dispatches one native command,
followed by the existing deliberate badge/list invalidation. A completed command stays consumed when that follow-up
observation fails; the page offers a current read, not another command. Sequential visits release the previous page and
callbacks; the browser growth check varies unrelated notice population and visits independently at 64, 512 and 4,096
while checking request, retained-row and materialized-byte bounds, including discarded candidates outside the 20-row
window. Nested native disclosure and acknowledgement examined-work stay with Content
([current inbox disclosure](../../../../services/kernel/src/content/README.md#cost-current-inbox-disclosure),
[notification inbox projection](../../../../services/kernel/src/content/README.md#cost-notification-inbox-projection),
[growth-notice-inbox](../../../../services/kernel/test/content/growth-notice-inbox.test.ts)
list/disclosure/unread cases); composed Inbox work keeps the original command and read counts in diagnostic output and
names Content's constant-row / logarithmic-block / 80-candidate list and 201-key unread window. Native database and
Access history growth are owned by Content, not inferred from browser requests.

Account integration follows Settings' [composed capability contract](../settings/README.md#composed-account-capabilities).
Inbox does not import Accounts Profile pages or request implementations. Its notification account identity remains the
immutable current viewer, independent of a managed Profile selection; account navigation never acknowledges a notice.
The existing Inbox runtime, browser and growth walks remain their sole evidence owners.
