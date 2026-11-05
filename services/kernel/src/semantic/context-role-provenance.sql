SELECT state,context_key::text AS "contextKey"
FROM semantic.enroll_context_role_provenance(
 :route::integer,:occurrence::bigint,:resource_id::uuid,:original_creator::uuid,:account_id::uuid,
 :grant_role::text,:valid::nullable(text),:side::text,:grant_transaction::nullable(uuid),:source_transaction::uuid
);
