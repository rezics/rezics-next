WITH input AS MATERIALIZED (
  SELECT :group::text AS group_name, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), inserted AS (
  INSERT INTO access.exposure_opening ("group", valid, transaction_id)
  SELECT input.group_name, tstzrange(input.at, NULL, '[)'), input.transaction_id
  FROM input
  WHERE NOT EXISTS (
    SELECT 1
    FROM access.exposure_opening opening
    WHERE opening."group" = input.group_name
      AND opening.valid @> input.at
  )
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM inserted) AS changed;
