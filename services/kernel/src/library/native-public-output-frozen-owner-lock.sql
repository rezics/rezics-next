SELECT 1 FROM library.collection c
JOIN core.partition p ON p.partition_no=c.route >> 4
WHERE c.route=$1 AND c.collection_id=$2 AND p.write_state='active' AND p.moved_to IS NULL
FOR UPDATE OF c,p;
