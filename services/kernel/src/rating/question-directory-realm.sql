SELECT q.id, q.owner_id AS "ownerId", q.realm_id AS "realmId", q.meaning, q.revision, q.label, q.grain,
       q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
       h.label AS "presentationLabel", h.revision AS "labelRevision"
FROM rating.question q
LEFT JOIN rating.question_label_head h ON h.question_id = q.id
WHERE q.realm_id = :realm_id::uuid AND q.id > :after_id::uuid
ORDER BY q.id
LIMIT (:limit::integer + 1);
