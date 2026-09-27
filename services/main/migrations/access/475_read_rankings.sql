CREATE TABLE access.read_ranking_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation uuid NOT NULL,
  content_epoch uuid NOT NULL,
  content_sequence bigint NOT NULL DEFAULT 0 CHECK (content_sequence >= 0),
  graph_epoch text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.read_ranking_score (
  generation uuid NOT NULL,
  metric text NOT NULL CHECK (metric IN ('reads', 'finished-chapters')),
  interval text NOT NULL CHECK (interval IN ('day', 'week', 'month')),
  bucket date NOT NULL,
  work text NOT NULL CHECK (work ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  score bigint NOT NULL CHECK (score > 0),
  growth bigint NOT NULL,
  PRIMARY KEY (generation, metric, interval, bucket, work)
);
CREATE INDEX read_ranking_score_order ON access.read_ranking_score
  (generation, metric, interval, bucket, score DESC, work);
CREATE INDEX read_ranking_growth_order ON access.read_ranking_score
  (generation, metric, interval, bucket, growth DESC, work);
