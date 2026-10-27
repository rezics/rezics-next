-- The btree cursor traverses history as well as current memberships, with no
-- scan of other organizations or of already completed pages.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :transaction_id::uuid AS transaction_id
), batch AS MATERIALIZED (
  SELECT m.ctid AS tid, m.member_account_id, m.valid
  FROM input i, access.organization_close w
  JOIN access.organization_member m ON m.route = w.route AND m.organization_id = w.organization_id
  WHERE w.route = i.route AND w.organization_id = i.organization_id
    AND (m.member_account_id, m.valid) >
        (COALESCE(w.cursor_member, '00000000-0000-0000-0000-000000000000'::uuid),
         COALESCE(w.cursor_valid, 'empty'::tstzrange))
  ORDER BY m.member_account_id, m.valid
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
  SET cursor_member = last.member_account_id, cursor_valid = last.valid
  FROM input i, (SELECT * FROM batch ORDER BY member_account_id DESC, valid DESC LIMIT 1) last
  WHERE w.route = i.route AND w.organization_id = i.organization_id
  RETURNING w.organization_id
)
SELECT (SELECT count(*)::integer FROM removed) AS count,
       COALESCE((SELECT jsonb_agg(DISTINCT member_account_id) FROM removed), '[]'::jsonb) AS members;
