WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :identity_digest::text AS identity_digest,
         :operation_id::uuid AS operation_id, :chunk_index::bigint AS chunk_index,
         :family::text AS family, :admitted_units::integer AS admitted_units,
         :maximum::integer AS maximum, :seconds::integer AS seconds
), recorded AS MATERIALIZED (
  SELECT expires_at
  FROM access.write_rate_chunk AS chunk, input
  WHERE chunk.route = input.route AND chunk.identity_digest = input.identity_digest
    AND chunk.operation_id = input.operation_id AND chunk.chunk_index = input.chunk_index
    AND expires_at > statement_timestamp()
), charged AS (
  INSERT INTO access.write_rate_counter AS counter (route, identity_digest, family, count, expires_at)
  SELECT input.route, input.identity_digest, input.family, input.admitted_units,
         statement_timestamp() + input.seconds * interval '1 second'
  FROM input
  WHERE NOT EXISTS (SELECT FROM recorded)
  ON CONFLICT (route, identity_digest, family) DO UPDATE
  SET count = CASE
        WHEN counter.expires_at <= statement_timestamp() THEN EXCLUDED.count
        WHEN counter.count <= (SELECT maximum FROM input) - EXCLUDED.count THEN counter.count + EXCLUDED.count
        ELSE counter.count
      END,
      expires_at = CASE
        WHEN counter.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at
        ELSE counter.expires_at
      END
  RETURNING count > 0 AND (
      OLD.identity_digest IS NULL OR OLD.expires_at <= statement_timestamp() OR count > OLD.count
    ) AS allowed, expires_at
), marked AS (
  INSERT INTO access.write_rate_chunk AS chunk (route, identity_digest, operation_id, chunk_index, expires_at)
  SELECT input.route, input.identity_digest, input.operation_id, input.chunk_index, expires_at
  FROM charged, input WHERE allowed
  ON CONFLICT (route, identity_digest, operation_id, chunk_index) DO UPDATE
  SET expires_at = EXCLUDED.expires_at
  WHERE chunk.expires_at <= statement_timestamp()
  RETURNING expires_at
)
SELECT true AS allowed, 1::integer AS "retryAfter" FROM recorded
UNION ALL
SELECT charged.allowed,
       -- A concurrent first admission may commit after our snapshot. If its
       -- live ledger row wins the unique key, abort this entire statement so
       -- the speculative counter debit rolls back. The workflow retries the
       -- transient unavailable decision and then observes that recorded chunk.
       GREATEST(1, ceil(extract(epoch FROM charged.expires_at - statement_timestamp())))::integer
         / CASE WHEN NOT charged.allowed OR EXISTS (SELECT FROM marked) THEN 1 ELSE 0 END AS "retryAfter"
FROM charged;
