-- Keep the stored-stage bounds at the synchronous Jena command budget. Larger
-- imports need a separately admitted continuation/worker contract.
ALTER TABLE semantic.change_stage
  DROP CONSTRAINT change_stage_page_count_check,
  DROP CONSTRAINT change_stage_item_count_check,
  DROP CONSTRAINT change_stage_byte_count_check,
  ADD CONSTRAINT semantic_change_stage_pages_runtime CHECK (page_count BETWEEN 1 AND 8),
  ADD CONSTRAINT semantic_change_stage_items_runtime CHECK (item_count BETWEEN 1 AND 128),
  ADD CONSTRAINT semantic_change_stage_bytes_runtime CHECK (byte_count BETWEEN 1 AND 524288);

ALTER TABLE semantic.change_stage_page
  DROP CONSTRAINT change_stage_page_ordinal_check,
  DROP CONSTRAINT change_stage_page_item_count_check,
  DROP CONSTRAINT change_stage_page_byte_size_check,
  ADD CONSTRAINT semantic_change_stage_page_ordinal_runtime CHECK (ordinal BETWEEN 0 AND 7),
  ADD CONSTRAINT semantic_change_stage_page_items_runtime CHECK (item_count BETWEEN 1 AND 16),
  ADD CONSTRAINT semantic_change_stage_page_bytes_runtime CHECK (byte_size BETWEEN 1 AND 65536);

INSERT INTO content.receipt_action (action)
VALUES ('semantic.change.bulk')
ON CONFLICT DO NOTHING;
