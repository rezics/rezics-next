SELECT request_id::text, account_id::text, requested_at::text,
       requested_at >= orphaned_at + interval '720 hours'
         AND requested_at <= :at::timestamptz AS current_request
FROM community.realm_claim_request
WHERE route = :route::integer AND realm_id = :realm::uuid
  AND orphaned_at = :orphaned::timestamptz AND state = 'pending'
  AND request_id > :after::uuid
ORDER BY request_id
LIMIT :limit::integer;
