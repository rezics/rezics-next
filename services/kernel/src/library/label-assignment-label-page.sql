WITH source AS MATERIALIZED (
  SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
         slot_no AS "slotNo", deleted_at::text AS "deletedAt"
  FROM library.label_assignment
  WHERE route = :route AND account_id = :account_id AND label_id = :label_id
    AND subject_id > :after_subject_id::uuid
  ORDER BY subject_id LIMIT :limit::integer
)
SELECT * FROM source ORDER BY "subjectId";
