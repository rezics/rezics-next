SELECT COALESCE(NULLIF(:at::text, '')::timestamptz, transaction_timestamp())::text AS at,
  set_config('lock_timeout', '200ms', true) AS lock_timeout,
  set_config('statement_timeout', :timeout::text, true) AS statement_timeout;
