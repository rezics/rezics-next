SELECT g.partition_no,g.terminal,g.pending_job,g.pending_epoch
FROM unnest($1::integer[],$2::uuid[]) requested(partition_no,terminal)
JOIN LATERAL(SELECT * FROM semantic.identity_epoch_group WHERE (partition_no,terminal)=(requested.partition_no,requested.terminal) LIMIT 1) g ON true;
