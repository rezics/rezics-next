SELECT h.preparation_id::text AS "preparationId"
FROM library.type_preparation_header AS h
WHERE h.route = :route::integer AND h.account_id = :account_id::uuid
  AND h.binding ->> 'subjectId' = :subject_id::text AND h.binding ->> 'requestKey' = :request_key::text
  AND h.principal_namespace = :principal_namespace::jsonb
ORDER BY h.created_at DESC, h.preparation_id DESC LIMIT 1;
