SELECT epoch, generation::text AS generation,
       start_count::text AS "startCount", m::text AS m, c::text AS "C"
FROM rating.population_prior_epoch
WHERE route = :route::integer AND question_id = :question_id::uuid AND population_id = :population_id::uuid
FOR UPDATE;
