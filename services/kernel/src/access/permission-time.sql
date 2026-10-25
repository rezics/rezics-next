SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, clock_timestamp())::text AS at,
       clock_timestamp()::text AS "databaseAt";
