SELECT q.id, q.owner_id AS "ownerId", q.realm_id AS "realmId", q.meaning,
       q.revision, q.label, q.grain,
       q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
       COALESCE(lifecycle.state, 'active') AS state,
       COALESCE(lifecycle.revision, 1) AS "lifecycleRevision"
FROM rating.question q
LEFT JOIN rating.question_lifecycle lifecycle ON lifecycle.question_id = q.id
WHERE q.id = :question_id::uuid
FOR UPDATE OF q;
