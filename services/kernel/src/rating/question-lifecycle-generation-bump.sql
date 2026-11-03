INSERT INTO rating.question_lifecycle_generation(realm_id, generation)
VALUES (:realm_id::uuid, 1)
ON CONFLICT (realm_id) DO UPDATE
SET generation = rating.question_lifecycle_generation.generation + 1
RETURNING generation::text AS generation;
