-- The btree cursor traverses history as well as current memberships, with no
-- scan of other organizations or of already completed pages.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :transaction_id::uuid AS transaction_id
), batch AS MATERIALIZED (
  SELECT m.ctid AS tid, m.row_key
  FROM input i, access.organization_close w
  JOIN access.organization_member m ON m.route = w.route AND m.organization_id = w.organization_id
  WHERE w.route = i.route AND w.organization_id = i.organization_id
    AND m.row_key > COALESCE(w.cursor_row_key, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY m.row_key
  LIMIT 100
), removed AS (
  DELETE FROM access.organization_member m
  USING input i
  WHERE m.route = i.route AND m.organization_id = i.organization_id
    AND m.ctid = ANY (ARRAY(SELECT tid FROM batch))
  RETURNING m.member_account_id
), terminal AS (
  UPDATE access.lifecycle_membership_slot s
  SET terminal = true, transaction_id = i.transaction_id
  FROM input i
  WHERE s.route = i.route AND s.organization_id = i.organization_id AND NOT s.terminal
    AND s.member_account_id IN (SELECT member_account_id FROM removed)
  RETURNING s.member_account_id, s.reservation_id
), checkpoint AS (
  UPDATE access.organization_close w
  SET cursor_row_key = CASE WHEN (SELECT count(*) FROM batch) = 100
    THEN (SELECT row_key FROM batch ORDER BY row_key DESC LIMIT 1) END
  FROM input i
  WHERE w.route = i.route AND w.organization_id = i.organization_id
  RETURNING w.organization_id
)
SELECT (SELECT count(*)::integer FROM removed) AS count,
       COALESCE((SELECT jsonb_agg(DISTINCT member_account_id) FROM removed), '[]'::jsonb) AS members;
