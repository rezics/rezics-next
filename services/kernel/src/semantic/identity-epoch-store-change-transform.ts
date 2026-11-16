/** The immutable transform fits a fixed projection even when the persisted intent is wider. */
export const identityChangeTransformSQL = `SELECT substring(intent->>'kind' FROM '^(merge|unmerge|repoint)$') AS kind,
       substring(intent->>'survivor' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS survivor,
       substring(intent->>'original' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS original,
       substring(intent->>'terminal' FROM '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') AS terminal,
       remainder_terminal
FROM semantic.identity_epoch_job
WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state IN ('pending','published');`;
