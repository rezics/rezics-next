-- Review events have an independent Access sequence. The feed keeps the
-- review cursor separately from the graph relay cursor and stores references
-- only; every response rechecks the current review and public Work.
ALTER TABLE access.feed_checkpoint
  ADD COLUMN review_sequence numeric NOT NULL DEFAULT 0 CHECK (review_sequence >= 0);
ALTER TABLE access.feed_item DROP CONSTRAINT feed_item_kind_check;
ALTER TABLE access.feed_item ADD CONSTRAINT feed_item_kind_check
  CHECK (kind IN ('work', 'contribution', 'adoption', 'decision', 'discussion', 'reply', 'collection', 'review'));
