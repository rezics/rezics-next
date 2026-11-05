WITH keys AS MATERIALIZED (
  SELECT * FROM unnest(:routes::integer[],:subjects::uuid[],:candidates::uuid[]) AS k(route,subject_id,candidate_id)
)
SELECT c.*, r.source
FROM keys k JOIN semantic.candidate c USING(route,subject_id,candidate_id)
JOIN semantic.revision r ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=c.revision
JOIN semantic.source_candidate sc ON sc.route=c.route AND sc.subject_id=c.subject_id AND sc.candidate_id=c.candidate_id
  AND sc.source=:source::text AND sc.source=r.source->>'source'
  AND sc.external_id=r.source->>'external_id' AND sc.field_group=r.source->>'field_group'
WHERE NOT c.erasure_private
  AND NOT EXISTS(SELECT 1 FROM semantic.retraction t WHERE t.route=c.route AND t.subject_id=c.subject_id AND t.candidate_id=c.candidate_id);
