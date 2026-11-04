-- One Source provenance authority, shared by public Source and native leaf reads.
-- Point plans include the fallback for expanded compact candidates whose proposal
-- has no source tuple. Payload guarding never treats withheld provenance as absent.
WITH input AS NOT MATERIALIZED (
  SELECT :max_bytes::integer AS max_bytes
), entries AS MATERIALIZED (
  SELECT * FROM unnest(:routes::integer[], :subjects::uuid[], :candidates::uuid[], :slots::uuid[])
    AS e(route, subject_id, candidate_id, slot_id)
), provenance AS MATERIALIZED (
  SELECT e.subject_id::text AS subject_id, e.candidate_id::text AS id,
         COALESCE(proposed.source, recorded.source) AS source,
         COALESCE(proposed.revision, recorded.revision) AS revision
  FROM entries e
  LEFT JOIN LATERAL (
    SELECT r.source, r.revision FROM semantic.candidate c
    JOIN semantic.revision r
      ON r.route = c.route AND r.subject_id = c.subject_id AND r.revision = c.revision
    WHERE c.route = e.route AND c.subject_id = e.subject_id AND c.candidate_id = e.candidate_id
    LIMIT 1
  ) proposed ON true
  LEFT JOIN LATERAL (
    SELECT r.source, r.revision FROM (
      (SELECT route, subject_id, recorded_transaction_id FROM semantic.fact
       WHERE proposed.source IS NULL AND e.slot_id IS NOT NULL
         AND route = e.route AND subject_id = e.subject_id AND slot_id = e.slot_id
         AND statement_id = e.candidate_id AND statement_id IS NOT NULL
         AND kind = 'statement' AND operation = 'assert'
       ORDER BY log_seq DESC LIMIT 1)
      UNION ALL
      (SELECT route, subject_id, recorded_transaction_id FROM semantic.fact
       WHERE proposed.source IS NULL AND e.slot_id IS NULL
         AND route = e.route AND subject_id = e.subject_id
         AND statement_id = e.candidate_id AND statement_id IS NOT NULL
         AND kind = 'statement' AND operation = 'assert'
       ORDER BY log_seq DESC LIMIT 1)
    ) f
    JOIN LATERAL (
      SELECT source, revision FROM semantic.revision
      WHERE route = f.route AND subject_id = f.subject_id AND recorded_transaction_id = f.recorded_transaction_id
      LIMIT 1
    ) r ON true
    LIMIT 1
  ) recorded ON true
)
SELECT subject_id, id, revision, COALESCE(octet_length(source::text), 0) AS source_bytes,
       CASE WHEN source IS NULL OR octet_length(source::text) <= input.max_bytes THEN source END AS source
FROM provenance CROSS JOIN input;
