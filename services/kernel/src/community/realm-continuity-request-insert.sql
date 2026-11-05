INSERT INTO community.realm_claim_request
  (route, realm_id, request_id, account_id, orphaned_at, requested_at)
VALUES (:route::integer, :realm::uuid, :request::uuid, :account::uuid, :orphaned::timestamptz, :at::timestamptz)
ON CONFLICT (route, realm_id, orphaned_at, account_id) DO NOTHING
RETURNING request_id, requested_at::text;
