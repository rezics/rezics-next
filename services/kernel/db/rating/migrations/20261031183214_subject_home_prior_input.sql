-- migrate:up
-- A subject partition's versioned publication input; never an authority for the population.
CREATE TABLE rating.subject_home_prior_input (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  population_route integer NOT NULL CHECK (population_route BETWEEN 0 AND 65535),
  question_id uuid NOT NULL REFERENCES rating.question (id),
  population_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  epoch integer CHECK (epoch >= 1),
  status text NOT NULL CHECK (status IN ('absent', 'inactive', 'active')),
  m numeric(12, 4) CHECK (m BETWEEN 0 AND 10),
  c bigint CHECK (c >= 1),
  PRIMARY KEY (partition_no, population_route, question_id, population_id),
  CHECK (population_route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11)),
  CHECK ((status = 'absent' AND generation = 0 AND epoch IS NULL AND m IS NULL AND c IS NULL) OR
         (status = 'inactive' AND generation > 0 AND epoch IS NOT NULL AND m IS NULL AND c IS NULL) OR
         (status = 'active' AND generation > 0 AND epoch IS NOT NULL AND m IS NOT NULL AND c IS NOT NULL))
);

-- migrate:down
-- Forward only: publication inputs retain the generation floor against delayed delivery.
SELECT 1;
