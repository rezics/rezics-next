-- migrate:up
ALTER TABLE content.conversation_activity_episode
  ADD COLUMN public_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN source_event_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN coverage_state text NOT NULL DEFAULT 'uncovered',
  ADD COLUMN coverage_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN coverage_epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN coverage_position bigint NOT NULL DEFAULT 0,
  ADD COLUMN coverage_event_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN coverage_reply_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN coverage_latest_post_id uuid,
  ADD COLUMN coverage_latest_at timestamptz,
  ADD COLUMN coverage_thread_security_revision bigint,
  ADD COLUMN coverage_board_id uuid,
  ADD COLUMN coverage_board_security_revision bigint,
  ADD COLUMN coverage_board_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN repair_generation bigint,
  ADD COLUMN repair_after_created_at timestamptz,
  ADD COLUMN repair_after_post_id uuid,
  ADD COLUMN repair_missing_publication boolean NOT NULL DEFAULT false,
  ADD COLUMN repair_source_epoch integer,
  ADD COLUMN repair_source_position bigint,
  ADD CONSTRAINT conversation_activity_episode_source_event_seq_check
    CHECK (source_event_seq BETWEEN 0 AND 999),
  ADD CONSTRAINT conversation_activity_episode_coverage_state_check
    CHECK (coverage_state IN ('uncovered', 'repairing', 'current', 'unrecoverable')),
  ADD CONSTRAINT conversation_activity_episode_coverage_generation_check
    CHECK (coverage_generation > 0),
  ADD CONSTRAINT conversation_activity_episode_coverage_position_check
    CHECK (coverage_position >= 0),
  ADD CONSTRAINT conversation_activity_episode_coverage_event_seq_check
    CHECK (coverage_event_seq BETWEEN 0 AND 1000),
  ADD CONSTRAINT conversation_activity_episode_coverage_count_check
    CHECK (coverage_reply_count >= 0),
  ADD CONSTRAINT conversation_activity_episode_coverage_latest_check
    CHECK ((coverage_latest_post_id IS NULL) = (coverage_latest_at IS NULL)),
  ADD CONSTRAINT conversation_activity_episode_coverage_latest_route_check
    CHECK (coverage_latest_post_id IS NULL OR route = get_byte(uuid_send(coverage_latest_post_id), 10) * 256
      + get_byte(uuid_send(coverage_latest_post_id), 11)),
  ADD CONSTRAINT conversation_activity_episode_coverage_board_route_check
    CHECK (coverage_board_id IS NULL OR route = get_byte(uuid_send(coverage_board_id), 10) * 256
      + get_byte(uuid_send(coverage_board_id), 11)),
  ADD CONSTRAINT conversation_activity_episode_coverage_board_generation_check
    CHECK (coverage_board_generation >= 0),
  ADD CONSTRAINT conversation_activity_episode_repair_cursor_check
    CHECK ((repair_after_created_at IS NULL) = (repair_after_post_id IS NULL));

CREATE UNIQUE INDEX conversation_activity_opening_idx
  ON content.conversation_activity_episode (route, thread_id)
  WHERE opening;

CREATE INDEX conversation_activity_repair_idx
  ON content.conversation_activity_episode (route, thread_id, post_id)
  WHERE opening AND coverage_state IN ('uncovered', 'repairing');

CREATE INDEX conversation_activity_board_threads_idx
  ON content.thread (route, board_id, thread_id);

CREATE INDEX conversation_activity_public_post_page_idx
  ON content.post (route, thread_id, created_at, post_id)
  WHERE availability='available' AND visibility='published' AND NOT author_erased;

CREATE INDEX conversation_activity_public_latest_idx
  ON content.conversation_activity_episode (route, thread_id, contributed_at DESC, post_id DESC)
  WHERE native_eligible AND public_eligible AND contributed_at IS NOT NULL;

CREATE TABLE content.conversation_activity_board_frontier (
  route integer NOT NULL,
  board_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  source_event_seq integer NOT NULL CHECK (source_event_seq BETWEEN 0 AND 999),
  after_thread_id uuid,
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, board_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11))
);

CREATE INDEX conversation_activity_board_frontier_pending_idx
  ON content.conversation_activity_board_frontier (route, board_id)
  WHERE NOT complete;

CREATE INDEX conversation_activity_publication_source_idx
  ON core.outbox (partition_no, subject, position, event_seq)
  WHERE type = 'com.rezics.content.post.published.v1' AND payload_state = 'present';

CREATE TABLE content.conversation_activity_repair_frontier (
  partition_no integer PRIMARY KEY REFERENCES core.partition(partition_no),
  cut_epoch integer NOT NULL CHECK (cut_epoch > 0),
  cut_position bigint NOT NULL CHECK (cut_position >= 0),
  after_route integer,
  after_thread_id uuid,
  complete boolean NOT NULL DEFAULT false,
  repair_after_route integer,
  repair_after_thread_id uuid,
  CHECK ((after_route IS NULL) = (after_thread_id IS NULL)),
  CHECK ((repair_after_route IS NULL) = (repair_after_thread_id IS NULL)),
  CHECK (after_route IS NULL OR after_route BETWEEN partition_no * 16 AND partition_no * 16 + 15),
  CHECK (repair_after_route IS NULL OR repair_after_route BETWEEN partition_no * 16 AND partition_no * 16 + 15)
);

-- migrate:down
DROP TABLE content.conversation_activity_repair_frontier;
DROP INDEX content.conversation_activity_board_frontier_pending_idx;
DROP TABLE content.conversation_activity_board_frontier;
DROP INDEX core.conversation_activity_publication_source_idx;
DROP INDEX content.conversation_activity_public_latest_idx;
DROP INDEX content.conversation_activity_public_post_page_idx;
DROP INDEX content.conversation_activity_board_threads_idx;
DROP INDEX content.conversation_activity_repair_idx;
DROP INDEX content.conversation_activity_opening_idx;
ALTER TABLE content.conversation_activity_episode
  DROP CONSTRAINT conversation_activity_episode_repair_cursor_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_board_route_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_board_generation_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_latest_route_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_latest_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_count_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_event_seq_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_position_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_generation_check,
  DROP CONSTRAINT conversation_activity_episode_coverage_state_check,
  DROP CONSTRAINT conversation_activity_episode_source_event_seq_check,
  DROP COLUMN repair_source_position,
  DROP COLUMN repair_source_epoch,
  DROP COLUMN repair_missing_publication,
  DROP COLUMN repair_after_post_id,
  DROP COLUMN repair_after_created_at,
  DROP COLUMN repair_generation,
  DROP COLUMN coverage_board_security_revision,
  DROP COLUMN coverage_board_generation,
  DROP COLUMN coverage_board_id,
  DROP COLUMN coverage_thread_security_revision,
  DROP COLUMN coverage_latest_at,
  DROP COLUMN coverage_latest_post_id,
  DROP COLUMN coverage_reply_count,
  DROP COLUMN coverage_event_seq,
  DROP COLUMN coverage_position,
  DROP COLUMN coverage_epoch,
  DROP COLUMN coverage_generation,
  DROP COLUMN coverage_state,
  DROP COLUMN source_event_seq,
  DROP COLUMN public_eligible;
