-- Probe and close the single open interval through the partial key index.
-- T is checked on that row; no open row at T is a no-op.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :subject_id::uuid AS subject_id, :subject_role::text AS subject_role,
         :action::text AS action, :reason::text AS reason, :at::timestamptz AS at
), candidate AS MATERIALIZED (
  SELECT d.valid
  FROM access.resource_denial d
  JOIN input i
    ON d.route = i.route AND d.resource_id = i.resource_id
   AND d.subject_id = i.subject_id AND d.subject_role = i.subject_role
   AND d.action = i.action AND d.reason = i.reason
   AND upper_inf(d.valid)
), open_row AS (
  SELECT c.valid FROM candidate c, input i WHERE c.valid @> i.at
), updated AS (
  UPDATE access.resource_denial d
  SET valid = tstzrange(lower(d.valid), i.at, '[)')
  FROM input i, open_row o
  WHERE d.route = i.route AND d.resource_id = i.resource_id
    AND d.subject_id = i.subject_id AND d.subject_role = i.subject_role
    AND d.action = i.action AND d.reason = i.reason
    AND upper_inf(d.valid) AND d.valid = o.valid
    AND (lower_inf(d.valid) OR lower(d.valid) < i.at)
  RETURNING d.subject_id
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM open_row) THEN 'absent'
  WHEN EXISTS (SELECT 1 FROM updated) THEN 'closed'
  ELSE 'unclosable'
END AS outcome;
