-- Rankings seek only their Structure progress events. Comments, media and
-- other Content receipts neither delay the projection nor outdate its pages.
CREATE INDEX outbox_ranking_progress ON content.outbox(data_epoch,sequence)
  WHERE recipe = 'structure-progress-v1' AND sequence IS NOT NULL;
CREATE INDEX outbox_ranking_progress_pending ON content.outbox(id)
  WHERE recipe = 'structure-progress-v1' AND sequence IS NULL;
