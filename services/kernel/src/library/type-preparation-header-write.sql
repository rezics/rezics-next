INSERT INTO library.type_preparation_header
(route, account_id, preparation_id, binding_digest, binding, origin, principal_namespace, reservation_id,
 input_byte_length, input_digest, creation_transaction_id, creation_receipt, creation_commitment, created_at,
 source_identity, origin_identity)
VALUES (:route::integer, :account_id::uuid, :preparation_id::uuid, :binding_digest::text, :binding::jsonb,
 :origin::jsonb, :principal_namespace::jsonb, :reservation_id::nullable(uuid), :input_byte_length::bigint,
 :input_digest::bytea, :transaction_id::uuid, :receipt::jsonb, :commitment::text, :time::timestamptz,
 :source_identity::jsonb, :origin_identity::jsonb);
