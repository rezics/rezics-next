-- A bounded set of full subject keys; the lateral point lookup cannot turn into a figure-table hash scan.
SELECT figure.subject_id::text AS "subjectId", figure.count::text AS count,
       figure.mean::text AS mean, figure.score::text AS score,
       figure.prior_epoch AS "priorEpoch", figure.revision::text AS revision,
       figure.pending_position IS NOT NULL AS pending
FROM jsonb_to_recordset(:subjects::jsonb) AS requested(partition_no integer, route integer, subject_id uuid)
CROSS JOIN LATERAL (
  SELECT subject_id, count, mean, score, prior_epoch, revision, pending_position
  FROM rating.public_figure
  WHERE partition_no = requested.partition_no
    AND route = requested.route
    AND question_id = :question_id::uuid
    AND population_id = :population_id::uuid
    AND subject_id = requested.subject_id
  LIMIT 1
) AS figure;
