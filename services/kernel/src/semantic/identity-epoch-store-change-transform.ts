/** The immutable transform fits a fixed projection even when the persisted intent is wider. */
export const identityChangeTransformSQL = `SELECT substring(intent->>'kind' FROM '^(merge|unmerge|repoint)$') AS kind,
       substring(intent->>'survivor' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS survivor,
       substring(intent->>'original' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS original,
       substring(intent->>'terminal' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS terminal,
       remainder_terminal
FROM semantic.identity_epoch_job
WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='pending';`;

/** The one-key cursor validates the retained input's own control epoch before treating a keyset as empty. */
export const identityChangeFirstInputsSQL = `SELECT i.generation,i.terminal,i.control_partition,
  (p.partition_no IS NOT NULL) AS owner_current
 FROM semantic.identity_epoch_input i
 LEFT JOIN core.partition p ON p.partition_no=i.control_partition
   AND p.epoch=i.owner_epoch AND p.write_state='active'
 WHERE (i.partition_no,i.job_id)=($1,$2)
 ORDER BY i.terminal LIMIT 2`;
