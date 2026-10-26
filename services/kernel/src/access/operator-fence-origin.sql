-- Written in the same transaction that inserts the native fence receipt.
UPDATE access.lifecycle_fence_receipt
SET operator_account_id = :operator_id::uuid, operator_reservation_id = :reservation_id::uuid,
    operator_continuation_id = :continuation_id::uuid
WHERE route = :route::integer AND account_id = :account_id::uuid AND receipt_id = :receipt_id::uuid
RETURNING receipt_id;
