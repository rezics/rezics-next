WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :source::text AS source,
         :source_record_id::text AS source_record_id
), target AS MATERIALIZED (
  SELECT subject.subject_id
  FROM semantic.subject AS subject CROSS JOIN input
  WHERE subject.route = input.route AND subject.subject_id = input.subject_id
), deleted AS (
  DELETE FROM rating.source_statistic AS statistic
  USING input, target
  WHERE statistic.route = input.route
    AND statistic.subject_id = target.subject_id
    AND statistic.source = input.source
    AND statistic.source_record_id = input.source_record_id
  RETURNING statistic.source_record_id
)
SELECT EXISTS (SELECT 1 FROM target) AS "subjectExists",
       EXISTS (SELECT 1 FROM deleted) AS removed;
