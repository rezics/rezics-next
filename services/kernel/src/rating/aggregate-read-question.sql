-- The question id is its complete key; its encoded route selects the question home.
SELECT minimum_units AS "minimumUnits", maximum_units AS "maximumUnits", step_units AS "stepUnits"
FROM rating.question
WHERE id = :question_id::uuid;
