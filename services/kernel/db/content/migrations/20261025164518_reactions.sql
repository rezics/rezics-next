-- migrate:up
-- A slot belongs to its actor, independently of the target's home. Counts are
-- relayed from change events; no target foreign key or target-side write occurs.
CREATE TABLE content.reaction (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  actor_account_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('thread', 'post')),
  target_route integer NOT NULL CHECK (target_route BETWEEN 0 AND 65535),
  target_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route, actor_account_id, target_id),
  CHECK (route = get_byte(uuid_send(actor_account_id), 10) * 256 + get_byte(uuid_send(actor_account_id), 11)),
  CHECK (target_route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

-- migrate:down
DROP TABLE content.reaction;
