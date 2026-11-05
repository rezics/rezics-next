-- migrate:up
CREATE TABLE content.moderation_appeal (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  appeal_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  appellant_account_id uuid NOT NULL,
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 2000),
  thread_id uuid NOT NULL,
  board_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('upheld', 'reversed')),
  resolver_account_id uuid,
  resolver_statement text CHECK (char_length(resolver_statement) BETWEEN 1 AND 2000),
  resolved_at timestamptz,
  PRIMARY KEY (route, appeal_id),
  UNIQUE (route, decision_id),
  FOREIGN KEY (route, decision_id) REFERENCES content.moderation_decision (route, decision_id),
  CHECK (route = get_byte(uuid_send(appeal_id), 10) * 256 + get_byte(uuid_send(appeal_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK ((outcome IS NULL AND resolver_account_id IS NULL AND resolver_statement IS NULL AND resolved_at IS NULL)
    OR (outcome IS NOT NULL AND resolver_account_id IS NOT NULL AND resolver_statement IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX moderation_appeal_thread_pending_idx ON content.moderation_appeal
  (route, thread_id, created_at DESC, appeal_id DESC) WHERE outcome IS NULL;

-- Recipient-route projection, filled by committed appeal events. Statements and
-- authority remain on the decision route; lists recheck each selected target.
CREATE TABLE content.moderation_appeal_board (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  appeal_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  pending boolean NOT NULL,
  PRIMARY KEY (route, board_id, appeal_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11))
);
CREATE INDEX moderation_appeal_board_pending_idx ON content.moderation_appeal_board
  (route, board_id, created_at DESC, appeal_id DESC) WHERE pending;

-- migrate:down
DROP TABLE content.moderation_appeal_board;
DROP TABLE content.moderation_appeal;
