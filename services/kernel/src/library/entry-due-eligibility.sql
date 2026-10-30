WITH addressed AS MATERIALIZED (
  SELECT restore_until
  FROM library.entry_deleted
  WHERE route = :route::integer
    AND account_id = :account_id::uuid
    AND deletion_id = :deletion_id::uuid
  FOR UPDATE
)
SELECT :expected_original_deadline::timestamptz <= :time::timestamptz AS due,
       EXISTS (SELECT FROM addressed) AS present,
       EXISTS (SELECT FROM addressed WHERE restore_until = :expected_original_deadline::timestamptz) AS matches;
