-- Enroll even an absent original. The exact key survives absence so subsequent
-- insertion/deletion cannot leave a previously observed negative looking current.
INSERT INTO semantic.kind_type_anchor_fence(route, subject_id, version)
VALUES (:route::integer, :subject_id::uuid, 0)
ON CONFLICT (route, subject_id) DO UPDATE
SET version = semantic.kind_type_anchor_fence.version
RETURNING version::text;
