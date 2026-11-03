-- migrate:up
CREATE INDEX vote_own_current_page_idx ON rating.vote (route, voter_id, question_id, target_id)
  INCLUDE (units, revision, changed_at, counted_target) WHERE units IS NOT NULL;

-- migrate:down
DROP INDEX rating.vote_own_current_page_idx;
