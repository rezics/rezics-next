-- migrate:up
-- Native publication episodes, not disclosed totals. Access and cohort coverage
-- must be established independently before any figure can be returned.
CREATE TABLE content.conversation_activity_episode (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  post_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  opening boolean NOT NULL,
  contributed_at timestamptz,
  native_eligible boolean NOT NULL,
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, post_id),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (contributed_at IS NULL OR isfinite(contributed_at))
);

-- Removed posts and revision history cannot lengthen a live contribution seek.
CREATE INDEX conversation_activity_live_prefix_idx
  ON content.conversation_activity_episode (route, thread_id, contributed_at DESC, post_id DESC)
  INCLUDE (opening)
  WHERE native_eligible AND contributed_at IS NOT NULL;

-- migrate:down
DROP TABLE content.conversation_activity_episode;
