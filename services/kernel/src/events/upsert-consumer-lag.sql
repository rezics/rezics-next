INSERT INTO core.consumer_lag (consumer, oldest_pending_at, observed_at)
VALUES (:consumer, NULLIF(:oldest_pending_at, '')::timestamp with time zone, clock_timestamp())
ON CONFLICT (consumer) DO UPDATE
SET oldest_pending_at = EXCLUDED.oldest_pending_at,
    observed_at = EXCLUDED.observed_at;
