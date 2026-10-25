-- One open interval per denial key. The primary-key probe is equality on the
-- scalar key plus the range that contains T; a hit skips the insert.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :subject_id::uuid AS subject_id, :subject_role::text AS subject_role,
         :action::text AS action, :reason::text AS reason,
         :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), open_row AS (
  SELECT d.valid
  FROM access.resource_denial d
  JOIN input i
    ON d.route = i.route AND d.resource_id = i.resource_id
   AND d.subject_id = i.subject_id AND d.subject_role = i.subject_role
   AND d.action = i.action AND d.reason = i.reason
   AND d.valid @> i.at AND upper_inf(d.valid)
), inserted AS (
  INSERT INTO access.resource_denial
    (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
  SELECT route, resource_id, subject_id, subject_role, action, reason,
         tstzrange(at, NULL, '[)'), transaction_id
  FROM input
  WHERE NOT EXISTS (SELECT 1 FROM open_row)
  RETURNING subject_id
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM open_row) THEN 'open'
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'inserted'
  ELSE 'absent'
END AS outcome;
