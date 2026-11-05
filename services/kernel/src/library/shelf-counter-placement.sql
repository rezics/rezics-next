SELECT state, type_id::text AS "typeId"
FROM library.entry
WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
FOR UPDATE;
