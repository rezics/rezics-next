-- Better Auth 1.7.12 consume: accepted attempts advance last_request;
-- rejected attempts neither increment the count nor extend the rolling window.
INSERT INTO auth_attempt_counter AS counter (key, count, last_request, accepted)
VALUES ($1, 1, statement_timestamp(), true)
ON CONFLICT (key) DO UPDATE SET
  accepted = counter.last_request <= statement_timestamp() - $2 * interval '1 second' OR counter.count < $3,
  count = CASE
    WHEN counter.last_request <= statement_timestamp() - $2 * interval '1 second' THEN 1
    WHEN counter.count < $3 THEN counter.count + 1
    ELSE counter.count
  END,
  last_request = CASE
    WHEN counter.last_request <= statement_timestamp() - $2 * interval '1 second' OR counter.count < $3
      THEN GREATEST(counter.last_request, statement_timestamp())
    ELSE counter.last_request
  END
RETURNING accepted AS allowed,
  CASE WHEN accepted THEN NULL
    ELSE GREATEST(1, ceil(extract(epoch FROM last_request + $2 * interval '1 second' - clock_timestamp())))::integer
  END AS "retryAfter";
