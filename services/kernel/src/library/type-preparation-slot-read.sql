SELECT preparation_id::text AS "preparationId" FROM library.type_preparation_slot
WHERE route = :route::integer AND account_id = :account_id::uuid AND binding_digest = :binding_digest::text
FOR UPDATE;
