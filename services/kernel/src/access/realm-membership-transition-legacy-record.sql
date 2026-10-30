INSERT INTO access.realm_membership_reconciliation_item
(route,account_id,barrier_id,reservation_id,realm_id,hold_transaction_id,state)
VALUES (:route::integer,:account_id::uuid,:barrier_id::text,:reservation_id::uuid,:realm_id::uuid,:hold_transaction_id::uuid,:state::text)
ON CONFLICT (route,account_id,barrier_id,reservation_id) DO UPDATE SET state=EXCLUDED.state
WHERE realm_membership_reconciliation_item.realm_id=EXCLUDED.realm_id
 AND realm_membership_reconciliation_item.hold_transaction_id=EXCLUDED.hold_transaction_id;
