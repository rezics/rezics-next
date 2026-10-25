SELECT kind = 'actor' AND state = 'active' AND NOT authn_fenced
       AND operator_account_id IS NULL AND created_at <= :at::timestamptz AS eligible
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid;
