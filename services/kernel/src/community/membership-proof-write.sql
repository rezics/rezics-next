INSERT INTO community.realm_membership_proof
(route,realm_id,account_id,reservation_id,generation_id,operation_id,outcome,transaction_id,
 publication_transaction_id,principal_id,command_kind,command_key,at)
VALUES (:route::integer,:realm_id::uuid,:account_id::uuid,:reservation_id::uuid,:generation_id::uuid,
 :operation_id::text,:outcome::text,:transaction_id::uuid,NULLIF(:publication_transaction_id::text,'')::uuid,
 :principal_id::uuid,:command_kind::text,:command_key::text,:at::timestamptz)
RETURNING generation_id::text AS "generationId";
