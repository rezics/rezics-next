INSERT INTO content.conversation_activity_episode AS stored
  (route, post_id, thread_id, opening, contributed_at,
   native_eligible, security_revision, source_epoch, source_position)
VALUES
  (:route::integer, :post_id::uuid, :thread_id::uuid, :opening::boolean,
   :contributed_at::nullable(timestamptz), :eligible::boolean, :security_revision::bigint,
   :source_epoch::integer, :source_position::bigint)
ON CONFLICT (route, post_id) DO UPDATE SET
  contributed_at = LEAST(stored.contributed_at, EXCLUDED.contributed_at),
  native_eligible = EXCLUDED.native_eligible,
  security_revision = EXCLUDED.security_revision,
  source_epoch = GREATEST(stored.source_epoch, EXCLUDED.source_epoch),
  source_position = CASE
    WHEN stored.source_epoch > EXCLUDED.source_epoch THEN stored.source_position
    WHEN stored.source_epoch < EXCLUDED.source_epoch THEN EXCLUDED.source_position
    ELSE GREATEST(stored.source_position, EXCLUDED.source_position) END
WHERE stored.native_eligible IS DISTINCT FROM EXCLUDED.native_eligible
   OR stored.security_revision IS DISTINCT FROM EXCLUDED.security_revision
   OR stored.contributed_at IS DISTINCT FROM LEAST(stored.contributed_at, EXCLUDED.contributed_at)
   OR (stored.source_epoch, stored.source_position) < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING post_id;
