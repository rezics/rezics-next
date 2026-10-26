-- unbound: Global partition only: one exact group/time seek and at most one opening insert.
WITH input AS MATERIALIZED (
  SELECT :group::text AS group_name, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), inserted AS (
  INSERT INTO access.exposure_opening (route, "group", valid, transaction_id)
  SELECT 0, input.group_name, tstzrange(input.at, NULL, '[)'), input.transaction_id
  FROM input
  WHERE NOT EXISTS (
    SELECT 1
    FROM access.exposure_opening opening
    WHERE opening.route = 0 AND opening."group" = input.group_name
      AND opening.valid @> input.at
  )
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM inserted) AS changed;
