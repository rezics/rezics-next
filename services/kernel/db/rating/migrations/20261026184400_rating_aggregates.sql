-- migrate:up
CREATE TABLE rating.population_vote (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  target_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  counting_key text NOT NULL CHECK (counting_key ~ '^[0-9a-f]{64}$'),
  units integer CHECK (units IS NULL OR units BETWEEN 0 AND 20),
  at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (route, question_id, population_id, target_id, voter_id),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

CREATE INDEX population_vote_counted_idx
  ON rating.population_vote (route, question_id, population_id, target_id, counting_key, at DESC, voter_id)
  WHERE units IS NOT NULL;

CREATE INDEX population_vote_target_page_idx
  ON rating.population_vote (route, population_id, target_id, question_id, voter_id);

CREATE FUNCTION rating.nonnegative_histogram(histogram_values bigint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT cardinality(histogram_values) > 0
     AND array_position(histogram_values, NULL::bigint) IS NULL
     AND 0::bigint <= ALL(histogram_values)
$$;

CREATE TABLE rating.aggregate_component (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  target_id uuid NOT NULL,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  count bigint NOT NULL CHECK (count >= 0),
  sum bigint NOT NULL CHECK (sum >= 0),
  histogram bigint[] NOT NULL CHECK (rating.nonnegative_histogram(histogram)),
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (route, question_id, population_id, target_id, shard),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

-- migrate:down
-- Forward only: applied population votes and aggregate history cannot be discarded.
