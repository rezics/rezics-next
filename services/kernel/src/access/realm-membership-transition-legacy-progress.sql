SELECT after_id::text AS "afterId", completed FROM access.realm_membership_reconciliation
WHERE route=:route::integer AND account_id=:account_id::uuid AND barrier_id=:barrier_id::text;
