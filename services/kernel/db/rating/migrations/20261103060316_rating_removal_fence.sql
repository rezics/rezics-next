-- migrate:up
-- A deleted contribution must not become an absent, writable revision again.
-- Keep no units, counting keys or vote timestamps in the replay fence.
CREATE TABLE rating.population_vote_removal (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  question_id uuid NOT NULL,
  population_id uuid NOT NULL,
  target_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (route, question_id, population_id, target_id, voter_id),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

-- migrate:down
-- Forward only: forgetting a removal would permit old deliveries to restore it.
SELECT 1;
