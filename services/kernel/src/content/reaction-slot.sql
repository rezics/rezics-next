WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :actor_id::uuid AS actor_id,
         :target_kind::text AS target_kind, :target_route::integer AS target_route,
         :target_id::uuid AS target_id, :kind::nullable(text) AS kind, :at::timestamptz AS at
), changed AS (
  INSERT INTO content.reaction AS slot
    (route, actor_account_id, target_kind, target_route, target_id, kind, updated_at)
  SELECT route, actor_id, target_kind, target_route, target_id, kind, at FROM input WHERE kind IS NOT NULL
  ON CONFLICT (route, actor_account_id, target_id) DO UPDATE
    SET kind = EXCLUDED.kind, updated_at = EXCLUDED.updated_at
    WHERE slot.kind IS DISTINCT FROM EXCLUDED.kind
  RETURNING WITH (OLD AS previous) previous.kind AS previous_kind, slot.kind
), cleared AS (
  DELETE FROM content.reaction AS slot USING input i
  WHERE i.kind IS NULL AND slot.route=i.route AND slot.actor_account_id=i.actor_id AND slot.target_id=i.target_id
  RETURNING slot.kind AS previous_kind, NULL::text AS kind
)
SELECT previous_kind, kind FROM changed
UNION ALL SELECT previous_kind, kind FROM cleared;
