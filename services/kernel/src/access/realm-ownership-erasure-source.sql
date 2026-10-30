-- One native account-home snapshot. No participant status or completion dependency.
SELECT e.route, e.account_id::text AS "accountId", e.version, e.at::text AS at
FROM access.erasure e
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid
  AND EXISTS (
    SELECT 1 FROM access.account a
    WHERE a.route = e.route AND a.account_id = e.account_id
      AND a.state = 'deleted' AND a.authn_fenced
      AND EXISTS (
        SELECT 1 FROM access.lifecycle_fence_receipt f
        WHERE f.route = a.route AND f.account_id = a.account_id
          AND f.receipt_id = a.fence_receipt_id AND f.kind = 'tombstone'
      )
  );
