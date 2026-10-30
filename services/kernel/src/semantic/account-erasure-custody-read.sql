SELECT e.version, e.at::text,
       p.at = e.at AND f.at = e.at AS "sameObligation",
       p.partition_no = 4096 AND p.state = 'pending-shared-custody' AS "localPagesComplete",
       EXISTS (
         SELECT 1 FROM semantic.erasure_inbox i
         WHERE i.route = e.route AND i.account_id = e.account_id
           AND i.late AND i.state <> 'resolved'
       ) AS "unsettledLocator"
FROM access.erasure e
LEFT JOIN semantic.erasure_progress p ON p.route = e.route AND p.account_id = e.account_id
LEFT JOIN semantic.erasure_fence f ON f.route = e.route AND f.account_id = e.account_id
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid;
