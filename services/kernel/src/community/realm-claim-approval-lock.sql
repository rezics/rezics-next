SELECT c.account_id::text, c.orphaned_at::text, c.requested_at::text, c.state,
       c.requested_at >= c.orphaned_at + interval '720 hours'
         AND c.requested_at <= :at::timestamptz AS current_request
FROM community.realm_claim_request c
WHERE c.route = :route::integer AND c.realm_id = :realm::uuid AND c.request_id = :request::uuid
FOR UPDATE;
