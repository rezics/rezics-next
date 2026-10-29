UPDATE community.realm_membership_operation
SET member_account_id = CASE WHEN member_account_id = :account_id::uuid THEN NULL ELSE member_account_id END,
    initiator_account_id = CASE WHEN initiator_account_id = :account_id::uuid THEN NULL ELSE initiator_account_id END,
    original_operator_account_id = CASE WHEN original_operator_account_id = :account_id::uuid THEN NULL ELSE original_operator_account_id END,
    actor_client_id = NULL, actor_scopes = NULL, actor_requested_by = NULL, actor_authn_epoch = NULL,
    original_minimum_authn_epoch = NULL, original_delegation_transaction_id = NULL, original_delegation_issued_valid = NULL
WHERE route = :owner_route::integer AND operation_id = :owner_id::uuid
RETURNING operation_id;
