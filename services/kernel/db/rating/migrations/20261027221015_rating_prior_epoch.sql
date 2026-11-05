-- migrate:up
ALTER TABLE rating.public_figure
  ADD COLUMN pending_prior_generation bigint,
  ADD COLUMN published_prior_generation bigint NOT NULL DEFAULT 0
    CHECK (published_prior_generation >= 0),
  ADD CONSTRAINT public_figure_pending_prior_generation_check
    CHECK (pending_prior_generation IS NULL OR pending_prior_generation > 0);

CREATE INDEX public_figure_prior_pending_idx
  ON rating.public_figure (partition_no, route, question_id, population_id, subject_id)
  WHERE pending_prior_generation IS NOT NULL;

CREATE TABLE rating.population_total_component (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  count bigint NOT NULL CHECK (count >= 0),
  sum bigint NOT NULL CHECK (sum >= 0),
  needs_epoch_check boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, question_id, population_id, shard),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11))
);

CREATE INDEX population_total_epoch_check_idx
  ON rating.population_total_component (question_id, population_id, shard)
  WHERE needs_epoch_check;

CREATE INDEX aggregate_component_population_subject_idx
  ON rating.aggregate_component (question_id, population_id, target_id, route, shard)
  WHERE count > 0;

CREATE TABLE rating.population_prior_epoch (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  start_count bigint CHECK (start_count IS NULL OR start_count >= 50),
  m numeric(12, 4) CHECK (m IS NULL OR m BETWEEN 0 AND 10),
  c bigint CHECK (c IS NULL OR c >= 1),
  PRIMARY KEY (route, question_id, population_id),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11)),
  CHECK ((start_count IS NULL AND m IS NULL AND c IS NULL) OR
         (start_count IS NOT NULL AND m IS NOT NULL AND c IS NOT NULL)),
  CHECK ((epoch = 0 AND start_count IS NULL) OR epoch >= 1)
);

CREATE TABLE rating.population_prior_republish (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  after_subject_id uuid,
  PRIMARY KEY (route, question_id, population_id),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11))
);

INSERT INTO rating.population_total_component
  (route, question_id, population_id, shard, count, sum, needs_epoch_check)
SELECT get_byte(uuid_send(vote.population_id), 10) * 256 + get_byte(uuid_send(vote.population_id), 11),
       vote.question_id, vote.population_id,
       (get_byte(decode(vote.counting_key, 'hex'), 0) % 16)::smallint,
       count(*)::bigint, sum(vote.units)::bigint,
       vote.question_id = '00000000-0000-7000-8000-000000000001'::uuid
FROM rating.population_vote AS vote
WHERE vote.units IS NOT NULL
GROUP BY vote.question_id, vote.population_id,
         (get_byte(decode(vote.counting_key, 'hex'), 0) % 16);

-- migrate:down
-- Forward only: public figure history and frozen population prior epochs are durable derived state.
SELECT 1;
