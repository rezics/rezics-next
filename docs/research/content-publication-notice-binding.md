# First-publication notice binding

Reply and mention effects consume only `com.rezics.content.post.published.v1`.
Its closed payload contains `threadId`, `itemId`, `revisionId`, `actorId`,
`placeId`, `kind`, `subjectIds` and `activityAt`. Creation and revision events
continue to serve other consumers; they carry no notice authority.

Decision: resolve the exact available publication revision even when the current
head has advanced, while applying current source, container-chain and recipient
read authority, preferences and account lifecycle at delivery.

The native producer emits the publication event once for an immediately published
opening/reply or the first draft-to-published revision. Draft creation/edits and
later published edits remain silent. Mentions come from that event revision;
reply recipients come from the current source's exact parent or opening post.
Opening publication produces mentions but no reply notice. Reply precedence,
distinct-recipient limits and per-post deduplication continue to apply.
Registered effect workflow replay retains positive and negative outcomes, and
the notice store retains its unique source constraint and transactional failures.

The private publication fixture composes authenticated native authoring with the
existing registered production relay host. It delays the entire creation relay
until after draft A publishes B and advances to a newer head, then checks the
native recipient inboxes and stored outcomes. Other cases cover silent edits,
immediate publication, replay, preferences and current ancestor/recipient denial.

The runner adapter must forward optional `visibility` on post creation and
revision, and send the current revision as `If-Match` for revision authoring:
`POST /v1/threads/:threadId/posts` defaults to published; `POST
/v1/posts/:postId/revisions` preserves visibility when omitted and accepts
`draft` to `published` once. Opening publication updates thread and post together.
Authoring replay uses the original input, key and exact expected head.
