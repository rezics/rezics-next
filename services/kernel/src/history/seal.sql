INSERT INTO core.history_seal(partition_no,account_route,account_id,barrier_id,phase)
SELECT :partition_no::integer, e.route, e.account_id, e.account_id, 'sealed'
FROM access.erasure e WHERE e.route=:account_route AND e.account_id=:account_id
ON CONFLICT(partition_no,account_route,account_id) DO UPDATE
  SET barrier_id=EXCLUDED.barrier_id,
      phase=CASE WHEN core.history_seal.phase='complete' THEN 'complete' ELSE 'sealed' END
RETURNING partition_no;
