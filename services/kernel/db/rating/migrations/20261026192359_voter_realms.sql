-- migrate:up
CREATE TABLE rating.voter_realm (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  voter_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  joined_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('adding', 'counted', 'removing', 'uncounted')),
  cursor_question_id uuid,
  cursor_target_id uuid,
  limit_question_id uuid,
  limit_target_id uuid,
  rejoin boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, voter_id, realm_id),
  CHECK (route = get_byte(uuid_send(voter_id), 10) * 256 + get_byte(uuid_send(voter_id), 11)),
  CHECK ((cursor_question_id IS NULL) = (cursor_target_id IS NULL)),
  CHECK ((limit_question_id IS NULL) = (limit_target_id IS NULL)),
  CHECK (state IN ('adding', 'removing') OR cursor_question_id IS NULL),
  CHECK (state = 'removing' OR (limit_question_id IS NULL AND NOT rejoin)),
  CHECK (cursor_question_id IS NULL OR limit_question_id IS NULL
    OR (cursor_question_id, cursor_target_id) <= (limit_question_id, limit_target_id))
);

-- These indexes keep reads independent of other voters and of the waiting set's size.
CREATE INDEX voter_realm_capped_idx ON rating.voter_realm (route, voter_id, realm_id)
  WHERE state <> 'uncounted';
CREATE INDEX voter_realm_waiting_idx ON rating.voter_realm (route, voter_id, joined_at, realm_id)
  WHERE state = 'uncounted';

-- migrate:down
-- Forward only: population membership and its paging progress must not be discarded.
