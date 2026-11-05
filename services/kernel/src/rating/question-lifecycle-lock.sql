-- Change the owning tuple, without changing its immutable definition revision.
-- A waiter with an older SERIALIZABLE snapshot must retry before reading the head.
WITH question AS (
  UPDATE rating.question SET revision = revision
  WHERE id = :question_id::uuid
  RETURNING *
)
SELECT q.id, q.owner_id AS "ownerId", q.realm_id AS "realmId", q.meaning,
       q.revision, q.label, q.grain,
       q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
       COALESCE(lifecycle.state, 'active') AS state,
       COALESCE(lifecycle.revision, 1) AS "lifecycleRevision"
FROM question q
LEFT JOIN rating.question_lifecycle lifecycle ON lifecycle.question_id = q.id;
