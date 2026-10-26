-- migrate:up
ALTER TABLE rating.voter_realm
  ADD COLUMN transition_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE rating.population_pending (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  population_id uuid NOT NULL,
  pending_jobs integer NOT NULL CHECK (pending_jobs >= 0),
  PRIMARY KEY (route, population_id),
  CHECK (route = get_byte(uuid_send(population_id), 10) * 256 + get_byte(uuid_send(population_id), 11))
);

-- migrate:down
-- Forward only: active paging transitions and freshness counters must not be discarded.
