ALTER TABLE access.feed_item DROP CONSTRAINT feed_item_kind_check;
ALTER TABLE access.feed_item ADD CONSTRAINT feed_item_kind_check
  CHECK (kind IN ('work', 'added', 'contribution', 'adoption', 'decision', 'discussion', 'reply', 'collection', 'review'));
