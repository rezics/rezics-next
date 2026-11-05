-- migrate:up
CREATE TABLE content.moderation_decision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  decision_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('thread', 'post')),
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'takedown'),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 1024),
  decider_account_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  PRIMARY KEY (route, decision_id),
  UNIQUE (route, target_kind, target_id, security_revision),
  CHECK (route = get_byte(uuid_send(decision_id), 10) * 256 + get_byte(uuid_send(decision_id), 11)),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

-- migrate:down
DROP TABLE content.moderation_decision;
