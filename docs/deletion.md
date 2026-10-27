# Deletion

Every owner follows one deletion policy, so a person can undo a mistake, moderation keeps its evidence, and erasure
promises still hold.

- **Soft deletion is the default.** Deleting a post, review, Collection, library fact, subject contribution or any
  other user-owned record marks it deleted: it disappears from every read, search document, sitemap, count and
  feed at once, references to it render as a tombstone, and its owner can restore it within 30 days.
- **Purge is separate.** Removing the stored data is a distinct operation:
  - after the 30-day window, deleted personal and private data is purged automatically by bounded durable work;
  - account erasure follows the [account deletion](../services/kernel/src/access/README.md) rules: private data is
    purged when the window ends, retained public contributions are de-identified, and no platform action is needed,
    because erasure is the person's right;
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

Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.
