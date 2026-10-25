-- Probe the interval at T. The partial key index sees only open rows; a GiST
-- plan uses valid @> T to skip this key's closed history.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :subject_id::uuid AS subject_id, :subject_role::text AS subject_role,
         :action::text AS action, :reason::text AS reason,
         :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), candidate AS MATERIALIZED (
  SELECT d.valid
  FROM access.resource_denial d
  JOIN input i
    ON d.route = i.route AND d.resource_id = i.resource_id
   AND d.subject_id = i.subject_id AND d.subject_role = i.subject_role
   AND d.action = i.action AND d.reason = i.reason
   AND upper_inf(d.valid) AND d.valid @> i.at
), open_row AS (
  SELECT c.valid FROM candidate c
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
