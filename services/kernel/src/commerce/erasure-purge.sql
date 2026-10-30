DELETE FROM commerce.entitlement
WHERE route = :route::integer AND account_id = :account_id::uuid AND entitlement_id = ANY(:ids::uuid[]);
