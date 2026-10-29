# Deletion

Every owner follows one deletion policy, so a person can undo a mistake, moderation keeps its evidence, and erasure
promises still hold.

- **Soft deletion is the default.** Deleting a post, review, Collection, library fact, subject contribution or any
  other user-owned record marks it deleted: it disappears from every read, search document, sitemap, count and
  feed at once, references to it render as a tombstone, and its owner can restore it within 30 days.
- **Purge is separate.** Removing the stored data is a distinct operation:
  - after the 30-day window, deleted personal and private data is purged automatically by bounded durable work;
  - account erasure follows the [Account erasure](#account-erasure) protocol below and does not wait for the window;
    no platform action is needed, because erasure is the person's right;
  - an immediate purge before the window ends needs a platform permission and its own route or explicit parameter,
    never the ordinary delete call.
- **Purge the least data that serves the purpose.** A purge removes the fields that are personal or private
  (author link, body or image, contact data, network addresses) and keeps the record's
  skeleton: identifier, type, relations, aggregate counts and the tombstone, so threads, lists, counts and
  references stay consistent. A whole record is removed only when the skeleton itself is personal data, such as a
  private library fact that one account reads a subject.
- **Takedown and legal holds.** A takedown hides, it never deletes: it withholds the least that the notice covers
  (one image, one passage, one field, or the record when nothing smaller does), keeps the data for a counter-notice
  or a reversed decision to restore, and keeps the record's other fields visible. Only a legal order purges, through
  the platform route. A legal hold suspends the automatic purge for its records.
- **Evidence.** Moderation and audit records keep identifiers and decisions, not the deleted content, past the
  window.

## Account erasure

1. **Confirmation and T.** Account erasure is final at confirmation, with fresh authentication and the typed
   confirmation. That instant, T, is both a read and write fence: private and unlisted reads, exports, counts, media
   and producers reject the owner immediately. Every worker checks the fence before any effect. Authentication
   denial alone is not enough for public or unlisted routes. Imports and late webhooks can never recreate the
   account's data or benefits. The 30-day restore window applies to records deleted one by one; it never postpones
   account erasure. There is no account restore, and an account id is never reused.
2. **One terminal workflow.** Each account has one terminal erasure workflow, identified by the account and its
   barrier. Accounts owns the request and the overall outcome. The participant list is fixed and versioned: Access,
   Auth, Library, financial commerce, content and media, community, ratings and notices, semantic and Zones, search,
   imports, shared history (receipts, outbox events, editorial provenance, durable work), and delivery custody (media
   storage and caches). Each participant acknowledges that its cleanup actually happened or attests that no data of
   the account applies. Dispatching work or accepting an obligation is not completion; only minimized or erased
   payload is. Completion also waits for every open late item to be resolved and for the effects frontier: all
   envelopes committed before T must be delivered and their registered locator effect workflows finished.
   A minimal completion record lives in PostgreSQL outside DBOS history, so deleting workflow history
   cannot lose an unfinished obligation or let an old event reopen activity.
3. **Every role.** Cleanup follows every role the account held: author, editor, uploader, reporter, buyer, seller,
   delegate, operator, member and acting human. It is not limited to rows keyed by the account id.
4. **Shared copies.** Copies in shared stores are found through exact locators that the producing owner records
   atomically with the copy, or for a copy in another partition, by an effect behind the participant’s fence. The
   participant closes that fence before paging; an effect finding it closed records a late erasure item and handles
   the copy itself, resolving the item only after minimization or purge commits. Locators include receipt, outbox
   event, provenance transaction, durable work id, Auth record key, media
   object key, search document or import record. The store's owner minimizes them through a registered minimizer for
   that artifact type. There is no account-wide JSON scan, search for a person's name or central ownership graph.
   Every producer of personal data uses an indexed native ownership relation or records the exact locator. A new
   personal field or store needs its erasure disposition before release.
5. **Retention.** Private, unlisted and already deleted material is erased, including archived versions. Eligible
   public contributions keep only the published contribution with de-identified attribution (`Deleted account`). A
   dynamic Collection keeps its last completely published generation, never a pending one or a fresh evaluation.
   Published reading logs are erased. Financial records keep only the legally required subset, restricted and with
   an expiry. That subset is defined by the payment and tax retention schedule: jurisdiction, record categories,
   fields, purpose and expiry. The schedule remains an open external condition. Anything an owner keeps beyond these categories, including
   moderation evidence (reports, decisions, bans), is a retention exception under item 7: the store, fields, purpose
   and expiry must be stated in that owner's retention inventory and purged at expiry; without one it is erased,
   including the reporter of a report, which is private material.
6. **Bounded steps.** Every phase pages with keyset seeks over a small fixed number of raw keys and explicit byte
   limits, children before parents, releasing the connection before entering another partition. Total work grows
   with the account's own records; no step grows with unrelated data. Cleanup runs under narrow platform authority
   bound to the committed erasure obligation; it never restores the deleted initiator.
7. **Completion.** The outcome distinguishes active cleanup complete, retention exceptions outstanding (each named
   by fields, purpose and expiry), and backup expiry outstanding. Unknown custody, a failed participant or an
   unresolved external write keeps it incomplete. Completion is checked by indexed existence probes, never by full
   counts.
8. **First scope.** A coordinator plus each owner's cleanup uses the existing PostgreSQL, DBOS, OpenSearch and R2
   APIs. Account restore, a legal-hold engine, self-service export, a separate deletion service and per-account
   encryption are not built.

Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.
