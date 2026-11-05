WITH input AS NOT MATERIALIZED (
  SELECT :expected_original_deadline::timestamptz AS expected_original_deadline,
         :time::timestamptz AS at
), addressed AS MATERIALIZED (
  SELECT restore_until
  FROM library.entry_deleted
  WHERE route = :route::integer
    AND account_id = :account_id::uuid
    AND deletion_id = :deletion_id::uuid
  FOR UPDATE
)
SELECT input.expected_original_deadline <= input.at AS due,
       EXISTS (SELECT FROM addressed) AS present,
       EXISTS (SELECT FROM addressed WHERE restore_until = input.expected_original_deadline) AS matches
FROM input;
