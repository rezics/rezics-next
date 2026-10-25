SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, clock_timestamp())::text AS at;
