SELECT id, owner_id AS "ownerId", revision, label, grain, minimum_units AS "minimumUnits",
       maximum_units AS "maximumUnits", step_units AS "stepUnits"
FROM rating.question
WHERE id = :question_id::uuid;
