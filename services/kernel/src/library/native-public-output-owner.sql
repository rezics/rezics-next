-- Retained authority survives curator eligibility loss. New use checks lifecycle separately.
SELECT s.curator_account_id::text AS "accountId", p.epoch, p.position::text,
       s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text AS incarnation
FROM library.collection s
JOIN access.account a ON a.route=s.route AND a.account_id=s.curator_account_id
JOIN core.partition p ON p.partition_no=s.route >> 4
WHERE s.route=$1 AND s.collection_id=$2 AND p.write_state='active' AND p.moved_to IS NULL
FOR UPDATE OF s,p FOR SHARE OF a;
