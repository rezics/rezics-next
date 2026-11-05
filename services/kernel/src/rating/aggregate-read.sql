-- Target home only. The full primary-key prefix and shard CHECK bound this to sixteen rows.
SELECT count::text AS count, sum::text AS sum, histogram::text[] AS histogram,
       applied_at::text AS "appliedAt"
FROM rating.aggregate_component
WHERE route = :route::integer AND question_id = :question_id::uuid
  AND population_id = :population_id::uuid AND target_id = :target_id::uuid
ORDER BY shard;
