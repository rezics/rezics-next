-- Better Auth 1.7.12 consume: accepted attempts advance last_request;
-- rejected attempts neither increment the count nor extend the rolling window.
WITH input AS (SELECT $1::text AS key, $2::double precision AS window_seconds, $3::integer AS max_attempts)
INSERT INTO auth_attempt_counter AS counter (key, count, last_request, accepted)
SELECT key, 1, statement_timestamp(), true FROM input WHERE true
ON CONFLICT (key) DO UPDATE SET
  accepted = counter.last_request <= statement_timestamp() - (SELECT window_seconds FROM input) * interval '1 second' OR counter.count < (SELECT max_attempts FROM input),
  count = CASE
    WHEN counter.last_request <= statement_timestamp() - (SELECT window_seconds FROM input) * interval '1 second' THEN 1
    WHEN counter.count < (SELECT max_attempts FROM input) THEN counter.count + 1
    ELSE counter.count
  END,
  last_request = CASE
    WHEN counter.last_request <= statement_timestamp() - (SELECT window_seconds FROM input) * interval '1 second' OR counter.count < (SELECT max_attempts FROM input)
      THEN GREATEST(counter.last_request, statement_timestamp())
    ELSE counter.last_request
  END
RETURNING accepted AS allowed,
  CASE WHEN accepted THEN NULL
    ELSE GREATEST(1, ceil(extract(epoch FROM last_request + (SELECT window_seconds FROM input) * interval '1 second' - clock_timestamp())))::integer
  END AS "retryAfter";
