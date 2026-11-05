SELECT subject_id AS "subjectId", incarnation_id AS "incarnationId", state, revision
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = ANY(:subject_ids::uuid[]);
