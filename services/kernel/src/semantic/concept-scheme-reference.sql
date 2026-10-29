-- Each selected statement names its immutable proposing/recording revision.
-- Retraction probes use the same candidate prefix, independently of history.
SELECT wanted.candidate_id::text AS candidate_id, r.source,
       EXISTS (SELECT 1 FROM semantic.retraction t
         WHERE t.route = :route::integer AND t.subject_id = :subject_id::uuid
           AND t.candidate_id = wanted.candidate_id) AS retracted
FROM unnest(:candidate_ids::uuid[], :revisions::integer[]) WITH ORDINALITY AS wanted(candidate_id, revision, ordinal)
JOIN LATERAL (
  SELECT source FROM semantic.revision
  WHERE route = :route::integer AND subject_id = :subject_id::uuid AND revision = wanted.revision
  OFFSET 0
) r ON true
ORDER BY wanted.ordinal;
