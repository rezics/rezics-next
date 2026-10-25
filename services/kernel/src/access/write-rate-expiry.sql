WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route),
expired AS MATERIALIZED (
  SELECT rate.ctid, rate.identity_digest, rate.family
  FROM access.write_rate_counter AS rate, input
  WHERE rate.route = input.route
    AND expires_at < statement_timestamp() - interval '48 hours'
  ORDER BY expires_at, identity_digest, family
  -- A scalar batch cap keeps the ordered index path attractive even for small histories.
  LIMIT (SELECT 1000)
  FOR UPDATE SKIP LOCKED
)
DELETE FROM access.write_rate_counter AS rate
USING input
WHERE rate.route = input.route
  -- The locks keep these physical keys stable until this statement finishes.
  -- A bounded TID array forces exact row probes instead of a population-wide join.
  AND rate.ctid = ANY (ARRAY(SELECT ctid FROM expired))
  AND (rate.identity_digest, rate.family) IN (SELECT identity_digest, family FROM expired)
RETURNING rate.route, rate.identity_digest, rate.family;
