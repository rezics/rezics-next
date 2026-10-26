INSERT INTO rating.population_vote
  (route, question_id, population_id, target_id, voter_id, counting_key, units, at, revision)
VALUES
  (:route::integer, :question_id::uuid, :population_id::uuid, :target_id::uuid, :voter_id::uuid,
   :counting_key, :units::nullable(integer), :at::timestamptz, :revision::integer)
ON CONFLICT (route, question_id, population_id, target_id, voter_id) DO UPDATE
SET counting_key = EXCLUDED.counting_key,
    units = EXCLUDED.units,
    at = EXCLUDED.at,
    revision = EXCLUDED.revision
WHERE rating.population_vote.revision < EXCLUDED.revision
RETURNING 1;
