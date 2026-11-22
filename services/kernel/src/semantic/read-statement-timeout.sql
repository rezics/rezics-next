WITH previous AS MATERIALIZED (SELECT current_setting('statement_timeout') AS timeout),
requested AS (SELECT :timeout_ms::integer AS ms)
SELECT previous.timeout, set_config('statement_timeout',
  CASE WHEN previous.timeout <> '0' AND previous.timeout::interval <= requested.ms * interval '1 millisecond'
    THEN previous.timeout ELSE requested.ms::text END, false) AS applied
FROM previous CROSS JOIN requested LIMIT 1;
