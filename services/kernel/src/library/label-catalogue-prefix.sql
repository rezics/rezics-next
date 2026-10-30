-- Live names are unique per owner, so name ordering also orders (name,label_id).
-- Separate upper-bound branches retain an index condition under generic prepared plans.
WITH bounded AS MATERIALIZED (
  (SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
   FROM library.personal_label
   WHERE route = :route AND account_id = :account_id AND deleted_at IS NULL
     AND :upper::text IS NOT NULL
     AND normalized_name COLLATE "C" >= :prefix::text COLLATE "C"
     AND normalized_name COLLATE "C" < :upper::text COLLATE "C"
     AND normalized_name COLLATE "C" >= :after_name::text COLLATE "C"
     AND (normalized_name COLLATE "C", label_id) > (:after_name::text COLLATE "C", :after_label_id::uuid)
   ORDER BY normalized_name COLLATE "C" LIMIT :limit::integer)
  UNION ALL
  (SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
   FROM library.personal_label
   WHERE route = :route AND account_id = :account_id AND deleted_at IS NULL
     AND :upper::text IS NULL
     AND normalized_name COLLATE "C" >= :prefix::text COLLATE "C"
     AND normalized_name COLLATE "C" >= :after_name::text COLLATE "C"
     AND (normalized_name COLLATE "C", label_id) > (:after_name::text COLLATE "C", :after_label_id::uuid)
   ORDER BY normalized_name COLLATE "C" LIMIT :limit::integer)
)
SELECT * FROM bounded ORDER BY name COLLATE "C";
