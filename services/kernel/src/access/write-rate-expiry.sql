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
), deleted_counters AS (
  DELETE FROM access.write_rate_counter AS rate
  USING input
  WHERE rate.route = input.route
    -- The locks keep these physical keys stable until this statement finishes.
    -- A bounded TID array forces exact row probes instead of a population-wide join.
    AND rate.ctid = ANY (ARRAY(SELECT ctid FROM expired))
    AND (rate.identity_digest, rate.family) IN (SELECT identity_digest, family FROM expired)
  RETURNING rate.route, rate.identity_digest, rate.family
), expired_chunks AS MATERIALIZED (
  SELECT chunk.ctid, chunk.identity_digest, chunk.operation_id, chunk.chunk_index
  FROM access.write_rate_chunk AS chunk, input
  WHERE chunk.route = input.route
    AND expires_at < statement_timestamp() - interval '48 hours'
  ORDER BY expires_at, identity_digest, operation_id, chunk_index
  LIMIT (SELECT 1000 - cardinality(ARRAY(SELECT ctid FROM expired)))
  FOR UPDATE SKIP LOCKED
), deleted_chunks AS (
  DELETE FROM access.write_rate_chunk AS chunk
  USING input
  WHERE chunk.route = input.route
    AND chunk.ctid = ANY (ARRAY(SELECT ctid FROM expired_chunks))
    AND (chunk.identity_digest, chunk.operation_id, chunk.chunk_index)
        IN (SELECT identity_digest, operation_id, chunk_index FROM expired_chunks)
  RETURNING chunk.route, chunk.identity_digest, 'chunk'::text AS family
)
SELECT route, identity_digest, family FROM deleted_counters
UNION ALL
SELECT route, identity_digest, family FROM deleted_chunks;
