-- Population home only. Missing pending state means no population job was pending at this observation.
SELECT EXISTS (
  SELECT 1 FROM rating.population_pending
  WHERE route = :route::integer AND population_id = :population_id::uuid AND pending_jobs > 0
) AS updating;
