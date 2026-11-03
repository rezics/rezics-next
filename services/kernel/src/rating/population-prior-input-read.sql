-- Exact authoritative input, read only in its independently anchored population snapshot.
SELECT epoch, generation::text AS generation, question_identity AS "questionIdentity",
       start_count::text AS "startCount", m::text AS m, c::text AS "C"
FROM rating.population_prior_epoch
WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid;
