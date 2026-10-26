-- unbound: Global partition only: one exact group/time seek and at most one opening update or delete.
WITH input AS MATERIALIZED (
  SELECT :group::text AS group_name, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), removed AS (
  DELETE FROM access.exposure_opening opening
  USING input
  WHERE opening.route = 0 AND opening."group" = input.group_name
    AND opening.valid @> input.at
    AND lower(opening.valid) = input.at
  RETURNING 1
), closed AS (
  UPDATE access.exposure_opening opening
  SET valid = tstzrange(lower(opening.valid), input.at, '[)'),
      transaction_id = input.transaction_id
  FROM input
  WHERE opening.route = 0 AND opening."group" = input.group_name
    AND opening.valid @> input.at
    AND lower(opening.valid) < input.at
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM removed UNION ALL SELECT 1 FROM closed) AS changed;
