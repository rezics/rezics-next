INSERT INTO content.conversation_activity_episode AS stored
  (route, post_id, thread_id, opening, contributed_at,
   native_eligible, public_eligible, security_revision,
   source_epoch, source_position, source_event_seq)
SELECT incoming.route, incoming.post_id, incoming.thread_id, incoming.opening, incoming.contributed_at,
       incoming.native_eligible, incoming.public_eligible, incoming.security_revision,
       incoming.source_epoch, incoming.source_position, incoming.source_event_seq
FROM jsonb_to_recordset(:episodes::jsonb) AS incoming(
  route integer, post_id uuid, thread_id uuid, opening boolean, contributed_at timestamptz,
  native_eligible boolean, public_eligible boolean, security_revision bigint,
  source_epoch integer, source_position bigint, source_event_seq integer
)
ON CONFLICT (route, post_id) DO UPDATE SET
  thread_id = EXCLUDED.thread_id,
  opening = EXCLUDED.opening,
  contributed_at = CASE
    WHEN stored.contributed_at IS NULL THEN EXCLUDED.contributed_at
    WHEN EXCLUDED.contributed_at IS NULL THEN stored.contributed_at
    ELSE LEAST(stored.contributed_at, EXCLUDED.contributed_at) END,
  native_eligible = EXCLUDED.native_eligible,
  public_eligible = EXCLUDED.public_eligible,
  security_revision = EXCLUDED.security_revision,
  source_epoch = CASE WHEN (stored.source_epoch,stored.source_position,stored.source_event_seq)
    < (EXCLUDED.source_epoch,EXCLUDED.source_position,EXCLUDED.source_event_seq)
    THEN EXCLUDED.source_epoch ELSE stored.source_epoch END,
  source_position = CASE WHEN (stored.source_epoch,stored.source_position,stored.source_event_seq)
    < (EXCLUDED.source_epoch,EXCLUDED.source_position,EXCLUDED.source_event_seq)
    THEN EXCLUDED.source_position ELSE stored.source_position END,
  source_event_seq = CASE WHEN (stored.source_epoch,stored.source_position,stored.source_event_seq)
    < (EXCLUDED.source_epoch,EXCLUDED.source_position,EXCLUDED.source_event_seq)
    THEN EXCLUDED.source_event_seq ELSE stored.source_event_seq END
WHERE (stored.source_epoch, stored.source_position, stored.source_event_seq)
        < (EXCLUDED.source_epoch, EXCLUDED.source_position, EXCLUDED.source_event_seq)
   OR stored.native_eligible IS DISTINCT FROM EXCLUDED.native_eligible
   OR stored.public_eligible IS DISTINCT FROM EXCLUDED.public_eligible
   OR stored.security_revision IS DISTINCT FROM EXCLUDED.security_revision
   OR stored.contributed_at IS DISTINCT FROM COALESCE(stored.contributed_at, EXCLUDED.contributed_at)
RETURNING post_id;
