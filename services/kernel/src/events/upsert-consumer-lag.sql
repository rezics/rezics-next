-- Keep idle relay heartbeats below follow-count freshness without writing on every poll.
WITH candidate AS (
  SELECT c.consumer, NULLIF(c.oldest, '')::timestamptz AS oldest_pending_at, statement_timestamp() AS observed_at
  FROM unnest(:consumers::text[], :oldest_pending_ats::text[]) AS c(consumer, oldest)
)
INSERT INTO core.consumer_lag (consumer, oldest_pending_at, observed_at)
SELECT candidate.consumer, candidate.oldest_pending_at, candidate.observed_at
FROM candidate
WHERE NOT EXISTS (
  SELECT 1
  FROM core.consumer_lag AS existing
  WHERE existing.consumer = candidate.consumer
    AND existing.oldest_pending_at IS NOT DISTINCT FROM candidate.oldest_pending_at
    AND existing.observed_at > candidate.observed_at - interval '60 seconds'
)
ORDER BY candidate.consumer
ON CONFLICT (consumer) DO UPDATE
SET oldest_pending_at = EXCLUDED.oldest_pending_at,
    observed_at = EXCLUDED.observed_at;
