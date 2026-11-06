DELETE FROM commerce.entitlement
WHERE route = :route AND account_id = :account_id AND entitlement_id = ANY(:ids::uuid[])
RETURNING entitlement_id AS id;
