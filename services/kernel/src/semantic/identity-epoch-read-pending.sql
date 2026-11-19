SELECT g.partition_no,g.terminal,g.pending_job,g.pending_epoch
FROM semantic.identity_epoch_pending_groups($1::integer[],$2::uuid[]) g;
