WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :participants::text[] AS participants, :at::timestamptz AS at
)
UPDATE access.erasure e
SET completed_at = i.at
FROM input i
WHERE e.route = i.route AND e.account_id = i.account_id AND e.completed_at IS NULL
  AND (SELECT count(*) FROM access.erasure_acknowledgement
       WHERE route = i.route AND account_id = i.account_id
         AND participant = ANY(i.participants)) = cardinality(i.participants);
