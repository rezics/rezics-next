# Inbox watch presentation

Inbox uses the current private notifications list, capped count and forward seen marker. The retained native
DTO and Accounts kind catalogue admit `reply`, `mention` and `moderation_decision`. Content has adopted
`board_activity` for new published thread openings, but this base has neither that registered optional kind nor a
released watch notice DTO. No native thread-watch kind name is assumed.

Decision: keep watch decoding behind an unavailable local consumer binding until Content releases its native DTO;
unsupported notices fail the entire page instead of being filtered out or described as replies.

`watch-notices.ts` defines presentation categories, not wire kinds, routes or stored subscriptions. A future native
adapter supplies exact kind/field decoding and a current thread-only target read under the page's credential.
`loadInboxPage` accepts that adapter explicitly; its production default is unavailable. The adapter must return
null for unknown wire kinds, and null from a target read only for an undisclosed, removed or missing target.
Malformed responses and transport failures must throw. This port does not bind a producer or invent a watch API.
Post-backed notices reuse the existing post read; watch destinations additionally require the current post's exact
post and thread identities. Thread-only destinations require a matching current thread identity. Board notices open
the disclosed new thread, never a guessed board destination. Only current target text enters the presentation.

Native and adapter notices share validation, distinct-target caching and one distinct-author batch. One page has
at most 20 notices, one private list read, at most 20 target reads and one optional public actor batch. Unavailable
targets have no actor identity, text or destination; they never borrow a moderation actor. A malformed/unsupported
row fails the page. Unrecognized presentation kinds use neutral notification language. Opaque continuation,
retained unread counts and explicit forward seen recovery retain their existing semantics. No failed read marks
anything seen. Viewer retirement continues to discard late reads and seen recovery.

Inbox links to `/settings#notifications`. Settings explains thread updates, new thread openings on watched boards,
in-app-only delivery and mandatory moderation outcomes in every locale. It renders only the optional controls
returned by Accounts. `board_activity` has a localized name when natively supported; no default, storage or
thread-watch preference key is introduced. Existing `NotificationEditor` retains expected version, original
semantic patch and key, current-read recovery and session retirement. Watch management stays in Settings' existing
private Watches section; page watch controls remain with Web.

The mixed-watch, inaccessible-target and read-failure Page stories are illustrative consumer examples, not native
acceptance evidence. Root owns screenshot approval. The actual watch binding remains unavailable until the native
contract is delivered; no email, backfill, subscription store or second API is provided here.
