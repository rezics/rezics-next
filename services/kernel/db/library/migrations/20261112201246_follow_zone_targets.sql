-- migrate:up
-- Keep the common graph and its all-writer source hook atomic. Existing edges,
-- original-type immutability, reasons and both keyset indexes are unchanged.
ALTER TABLE library.follow DROP CONSTRAINT follow_target_type_check;
ALTER TABLE library.follow ADD CONSTRAINT follow_target_type_check
  CHECK (target_type IN ('subject', 'collection', 'space', 'zone'));
ALTER TABLE library.follow_count_source DROP CONSTRAINT follow_count_source_target_type_check;
ALTER TABLE library.follow_count_source ADD CONSTRAINT follow_count_source_target_type_check
  CHECK (target_type IN ('subject', 'collection', 'space', 'zone'));
ALTER TABLE library.follow_count_total DROP CONSTRAINT follow_count_total_target_type_check;
ALTER TABLE library.follow_count_total ADD CONSTRAINT follow_count_total_target_type_check
  CHECK (target_type IN ('subject', 'collection', 'space', 'zone'));

-- migrate:down
-- Forward only: retained Zone edges and negative source revisions must survive.
