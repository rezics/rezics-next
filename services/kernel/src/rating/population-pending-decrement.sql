UPDATE rating.population_pending
SET pending_jobs = pending_jobs - 1
WHERE route = :route::integer AND population_id = :population_id::uuid AND pending_jobs > 0
RETURNING pending_jobs;
