-- migrate:up
-- Raw review key seeks include hidden and withdrawn identities so gate changes behind a
-- continuation are covered by the dependency cut.
CREATE INDEX thread_review_discovery_population_idx
  ON content.thread(route,thread_id) WHERE kind='review';

-- Per-review sourceVersion reads the latest identity-only lifecycle position.
CREATE INDEX review_discovery_change_latest
  ON content.review_discovery_change(route,thread_id,position DESC);

-- A bounded existence probe withholds population cuts while durable invalidations are pending.
CREATE INDEX review_discovery_work_pending
  ON content.review_discovery_work(route,id) WHERE complete=false;

-- migrate:down
DROP INDEX content.review_discovery_work_pending;
DROP INDEX content.review_discovery_change_latest;
DROP INDEX content.thread_review_discovery_population_idx;
