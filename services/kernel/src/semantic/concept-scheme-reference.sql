-- Each selected statement names its immutable proposing/recording revision.
-- Retraction probes use the same candidate prefix, independently of history.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT wanted.candidate_id::text AS candidate_id, r.source,
       EXISTS (SELECT 1 FROM semantic.retraction t
         WHERE t.route = input.route AND t.subject_id = input.subject_id
           AND t.candidate_id = wanted.candidate_id) AS retracted
FROM input CROSS JOIN unnest(:candidate_ids::uuid[], :revisions::integer[])
  WITH ORDINALITY AS wanted(candidate_id, revision, ordinal)
JOIN LATERAL (
  SELECT source FROM semantic.revision
  WHERE route = input.route AND subject_id = input.subject_id AND revision = wanted.revision
  OFFSET 0
) r ON true
ORDER BY wanted.ordinal;
