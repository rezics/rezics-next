SELECT id, revision, label, grain, minimum_units AS "minimumUnits",
       maximum_units AS "maximumUnits", step_units AS "stepUnits"
FROM rating.question
WHERE id > :after_id::uuid
ORDER BY id
LIMIT (:limit::integer + 1);
