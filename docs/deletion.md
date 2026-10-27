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
- **Takedown and legal holds.** A takedown withholds the record at once, as a deletion does; whether its data is
  later purged or kept follows the legal process, and a legal hold suspends the automatic purge for that record.
- **Evidence.** Moderation and audit records keep identifiers and decisions, not the deleted content, past the
  window.

Each owner documents in its README which records it soft-deletes, how restore works, and its purge job's bound.
