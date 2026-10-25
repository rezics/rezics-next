SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, transaction_timestamp())::text AS at;
