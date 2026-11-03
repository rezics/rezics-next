SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain,
       minimum_units AS "minimumUnits", maximum_units AS "maximumUnits", step_units AS "stepUnits"
FROM rating.question
WHERE realm_id = :realm_id::uuid AND id > :after_id::uuid
ORDER BY id
LIMIT (:limit::integer + 1);
