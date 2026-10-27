-- migrate:up
CREATE TABLE rating.public_figure (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  mean numeric(12, 4),
  score numeric(12, 4),
  m numeric(12, 4),
  c bigint,
  prior_epoch integer CHECK (prior_epoch IS NULL OR prior_epoch >= 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  as_of timestamptz,
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
  pending_position bigint CHECK (pending_position IS NULL OR pending_position > position),
  PRIMARY KEY (route, question_id, population_id, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK ((mean IS NULL OR mean BETWEEN 0 AND 10) AND (m IS NULL OR m BETWEEN 0 AND 10)),
  CHECK ((score IS NULL OR score BETWEEN 0 AND 10) AND (c IS NULL OR c >= 1))
);

CREATE INDEX public_figure_pending_idx
  ON rating.public_figure (partition_no, route, question_id, population_id, subject_id)
  WHERE pending_position IS NOT NULL;

CREATE INDEX public_figure_population_subject_idx
  ON rating.public_figure (partition_no, question_id, population_id, subject_id)
  WHERE revision > 0;

-- migrate:down
-- Forward only: public rating figures and their publication revisions are durable history.
SELECT 1;
