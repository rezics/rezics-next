INSERT INTO content.conversation_activity_episode AS stored
  (route, post_id, thread_id, opening, contributed_at,
   native_eligible, public_eligible, security_revision, source_epoch, source_position, source_event_seq)
VALUES
  (:route::integer, :post_id::uuid, :thread_id::uuid, :opening::boolean,
   :contributed_at::nullable(timestamptz), :eligible::boolean, :public_eligible::boolean,
   :security_revision::bigint, :source_epoch::integer, :source_position::bigint, :source_event_seq::integer)
ON CONFLICT (route, post_id) DO UPDATE SET
  contributed_at = LEAST(stored.contributed_at, EXCLUDED.contributed_at),
  native_eligible = EXCLUDED.native_eligible,
  public_eligible = EXCLUDED.public_eligible,
  security_revision = EXCLUDED.security_revision,
  source_epoch = CASE
    WHEN (stored.source_epoch, stored.source_position, stored.source_event_seq)
      < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)
      THEN EXCLUDED.source_epoch ELSE stored.source_epoch END,
  source_position = CASE
    WHEN (stored.source_epoch, stored.source_position, stored.source_event_seq)
      < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)
      THEN EXCLUDED.source_position ELSE stored.source_position END,
  source_event_seq = CASE
    WHEN (stored.source_epoch, stored.source_position, stored.source_event_seq)
      < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)
      THEN EXCLUDED.source_event_seq ELSE stored.source_event_seq END
WHERE stored.native_eligible IS DISTINCT FROM EXCLUDED.native_eligible
   OR stored.public_eligible IS DISTINCT FROM EXCLUDED.public_eligible
   OR stored.security_revision IS DISTINCT FROM EXCLUDED.security_revision
   OR stored.contributed_at IS DISTINCT FROM LEAST(stored.contributed_at, EXCLUDED.contributed_at)
   OR (stored.source_epoch, stored.source_position, stored.source_event_seq)
      < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)
RETURNING post_id;
