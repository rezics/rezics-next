ALTER TABLE access.read_ranking_checkpoint ADD COLUMN content_scan_sequence bigint;
UPDATE access.read_ranking_checkpoint SET content_scan_sequence = content_sequence;
ALTER TABLE access.read_ranking_checkpoint ALTER COLUMN content_scan_sequence SET DEFAULT 0;
ALTER TABLE access.read_ranking_checkpoint ALTER COLUMN content_scan_sequence SET NOT NULL;
ALTER TABLE access.read_ranking_checkpoint ADD COLUMN review_scan_position bigint;
UPDATE access.read_ranking_checkpoint SET review_scan_position = review_position;
ALTER TABLE access.read_ranking_checkpoint ALTER COLUMN review_scan_position SET DEFAULT 0;
ALTER TABLE access.read_ranking_checkpoint ALTER COLUMN review_scan_position SET NOT NULL;
ALTER TABLE access.read_ranking_checkpoint ADD CHECK (content_scan_sequence >= content_sequence);
ALTER TABLE access.read_ranking_checkpoint ADD CHECK (review_scan_position >= review_position);
CREATE TABLE access.read_ranking_pending (
  generation uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('content', 'review')),
  position bigint NOT NULL CHECK (position > 0),
  target text NOT NULL,
  source_event jsonb NOT NULL,
  PRIMARY KEY (generation, source, position)
);
CREATE INDEX read_ranking_pending_target ON access.read_ranking_pending(generation, source, target, position);
CREATE TABLE access.read_ranking_target (
  generation uuid NOT NULL,
  source text NOT NULL,
  target text NOT NULL,
  first_position bigint NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation, source, target),
  FOREIGN KEY (generation, source, first_position)
    REFERENCES access.read_ranking_pending(generation, source, position) ON DELETE CASCADE
);
CREATE INDEX read_ranking_target_retry ON access.read_ranking_target(generation, attempted_at, source, first_position);
