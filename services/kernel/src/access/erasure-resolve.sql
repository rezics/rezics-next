WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :participant::text AS participant, :store::text AS store, :at::timestamptz AS at
), existing AS MATERIALIZED (
  SELECT a.*, i.store, i.at
  FROM access.erasure_acknowledgement a CROSS JOIN input i
  WHERE a.route = i.route AND a.account_id = i.account_id AND a.participant = i.participant
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.retained) x
                WHERE x->>'store' = i.store AND (x->>'expiresAt')::timestamptz <= i.at)
  FOR UPDATE OF a
), updated AS (
  UPDATE access.erasure_acknowledgement a
  SET resolutions = a.resolutions || jsonb_build_object(e.store, e.at)
  FROM existing e
  WHERE a.route = e.route AND a.account_id = e.account_id AND a.participant = e.participant
    AND NOT (e.resolutions ? e.store)
  RETURNING true AS changed
)
SELECT changed FROM updated
UNION ALL
SELECT false AS changed FROM existing WHERE resolutions ? store;
