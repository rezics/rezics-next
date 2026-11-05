-- migrate:up
CREATE TABLE rating.voter_state (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'eligible' CHECK (state IN ('eligible', 'leaving', 'ineligible', 'returning')),
  cursor_question_id uuid,
  cursor_target_id uuid,
  transition_id uuid NOT NULL DEFAULT gen_random_uuid(),
  purge_votes boolean NOT NULL DEFAULT false,
  populations uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (route, voter_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11)),
  CHECK ((cursor_question_id IS NULL) = (cursor_target_id IS NULL)),
  CHECK (state IN ('leaving', 'returning') OR cursor_question_id IS NULL),
  CHECK (NOT purge_votes OR state = 'leaving'),
  CHECK (cardinality(populations) <= 101)
);

INSERT INTO rating.voter_state (route, voter_id)
SELECT route, voter_id FROM rating.vote
UNION
SELECT route, voter_id FROM rating.voter_realm
ON CONFLICT (route, voter_id) DO NOTHING;

-- migrate:down
-- Forward only: eligibility jobs and source-vote deletion are irreversible.
