-- migrate:up
ALTER TABLE content.board_slow_mode
  ADD COLUMN security_episode bigint NOT NULL DEFAULT 1 CHECK (security_episode > 0),
  ADD COLUMN in_flight_count integer NOT NULL DEFAULT 0 CHECK (in_flight_count >= 0);

ALTER TABLE content.board_slow_actor
  ALTER COLUMN posted_at DROP NOT NULL,
  ADD COLUMN next_episode bigint NOT NULL DEFAULT 0 CHECK (next_episode >= 0);

CREATE INDEX board_slow_actor_key_idx ON content.board_slow_actor (actor_key, route, board_id);
CREATE INDEX board_slow_actor_retention_idx
  ON content.board_slow_actor (posted_at, route, board_id, actor_key);
CREATE INDEX board_slow_actor_no_post_idx
  ON content.board_slow_actor (route, board_id, actor_key) WHERE posted_at IS NULL;

ALTER TABLE content.account_erasure_progress DROP CONSTRAINT account_erasure_progress_phase_check;
UPDATE content.account_erasure_progress
SET phase='slow-mode',cursor=NULL,phase_pending=false
WHERE phase <> 'complete';
ALTER TABLE content.account_erasure_progress
  ADD CONSTRAINT account_erasure_progress_phase_check
  CHECK (phase IN ('slow-mode','authored','uploads','reactions','moderation','notices','proof','complete'));

CREATE TABLE content.board_slow_permit (
  route integer NOT NULL,
  board_id uuid NOT NULL,
  actor_key bytea NOT NULL CHECK (octet_length(actor_key) = 32),
  command_key bytea NOT NULL CHECK (octet_length(command_key) = 32),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  thread_route integer NOT NULL CHECK (thread_route BETWEEN 0 AND 65535),
  command_kind text NOT NULL CHECK (command_kind IN ('content.thread.create', 'content.post.create', 'content.post.revise')),
  generation bigint NOT NULL CHECK (generation > 0),
  security_episode bigint NOT NULL CHECK (security_episode > 0),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 0 AND 86400),
  state text NOT NULL CHECK (state IN ('reserved', 'in_flight', 'reconciling', 'complete', 'cancelled', 'pruning')),
  recovery_from_state text CHECK (recovery_from_state IN ('reserved', 'in_flight')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (route, board_id, actor_key, command_key),
  FOREIGN KEY (route, board_id) REFERENCES content.board(route, board_id) ON DELETE CASCADE,
  FOREIGN KEY (route, board_id, actor_key) REFERENCES content.board_slow_actor(route, board_id, actor_key) ON DELETE CASCADE
);

CREATE UNIQUE INDEX board_slow_permit_one_active_actor_idx
  ON content.board_slow_permit (route, board_id, actor_key)
  WHERE state IN ('reserved', 'in_flight', 'reconciling');
CREATE INDEX board_slow_permit_recovery_idx
  ON content.board_slow_permit (updated_at, route, board_id, actor_key, command_key)
  WHERE state IN ('reserved', 'in_flight', 'reconciling');
CREATE INDEX board_slow_permit_retention_idx
  ON content.board_slow_permit (completed_at, route, board_id, actor_key, command_key)
  WHERE state IN ('complete', 'cancelled', 'pruning');

CREATE TABLE content.board_slow_ticket (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  command_key bytea NOT NULL CHECK (octet_length(command_key) = 32),
  generation bigint NOT NULL CHECK (generation > 0),
  board_route integer NOT NULL CHECK (board_route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  command_kind text NOT NULL CHECK (command_kind IN ('content.thread.create', 'content.post.create', 'content.post.revise')),
  state text NOT NULL CHECK (state IN ('reserved', 'committed', 'replayed', 'cancelled')),
  target_post_id uuid,
  revision_id uuid,
  transaction_id uuid,
  posted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (route, command_key),
  CHECK (state <> 'committed' OR
    (target_post_id IS NOT NULL AND revision_id IS NOT NULL AND transaction_id IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (state <> 'replayed' OR (target_post_id IS NOT NULL AND revision_id IS NOT NULL))
);

CREATE INDEX board_slow_permit_actor_key_idx
  ON content.board_slow_permit (actor_key, route, board_id, command_key);

-- migrate:down
DROP INDEX content.board_slow_permit_actor_key_idx;
DROP TABLE content.board_slow_ticket;
DROP TABLE content.board_slow_permit;
DROP INDEX content.board_slow_actor_no_post_idx;
DROP INDEX content.board_slow_actor_retention_idx;
DROP INDEX content.board_slow_actor_key_idx;
ALTER TABLE content.account_erasure_progress DROP CONSTRAINT account_erasure_progress_phase_check;
UPDATE content.account_erasure_progress
SET phase='authored',cursor=NULL,phase_pending=false
WHERE phase='slow-mode';
ALTER TABLE content.account_erasure_progress
  ADD CONSTRAINT account_erasure_progress_phase_check
  CHECK (phase IN ('authored','uploads','reactions','moderation','notices','proof','complete'));
DELETE FROM content.board_slow_actor WHERE posted_at IS NULL;
ALTER TABLE content.board_slow_actor
  DROP COLUMN next_episode,
  ALTER COLUMN posted_at SET NOT NULL;
ALTER TABLE content.board_slow_mode
  DROP COLUMN in_flight_count,
  DROP COLUMN security_episode;
