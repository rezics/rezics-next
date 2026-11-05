INSERT INTO rating.population_pending (route, population_id, pending_jobs)
VALUES (:route::integer, :population_id::uuid, 1)
ON CONFLICT (route, population_id) DO UPDATE
SET pending_jobs = rating.population_pending.pending_jobs + 1
RETURNING pending_jobs;
