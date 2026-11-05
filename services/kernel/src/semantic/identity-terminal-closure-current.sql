SELECT g.partition_no,g.terminal,g.published_epoch,g.owner_epoch,g.generation,
 g.closure_state,g.closure_incarnation,requested.original AS requested_original,
 o.closure_state AS directory_state,o.closure_enrollment AS directory_enrollment,
 o.closure_incarnation AS directory_incarnation,o.closure_install_transaction AS directory_install,
 o.closure_export_transaction AS directory_export,o.closure_source_revision AS directory_revision,
 o.closure_source_epoch AS directory_owner,
 n.transaction_id AS registration_transaction,coalesce(r.redirected,false) redirected
FROM unnest($1::integer[],$2::uuid[],$3::uuid[]) requested(partition_no,terminal,original)
-- Keep each unique-key lookup parameterized by this selected row. Flattening
-- these joins lets the planner scan a home/generation before matching originals.
JOIN LATERAL(SELECT * FROM semantic.identity_epoch_group
 WHERE (partition_no,terminal)=(requested.partition_no,requested.terminal) LIMIT 1) g ON true
LEFT JOIN LATERAL(SELECT * FROM semantic.identity_epoch_original
 WHERE (partition_no,generation,original)=(g.partition_no,g.generation,requested.original) LIMIT 1) o ON true
LEFT JOIN LATERAL(SELECT transaction_id FROM semantic.identity_epoch_native_commit
 WHERE partition_no=o.partition_no AND transaction_id=o.closure_registration_transaction
 AND xmin::text=o.closure_registration_xid LIMIT 1) n ON true
LEFT JOIN LATERAL(SELECT true redirected FROM semantic.redirect
 WHERE subject_id=g.terminal
 AND route=(get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11)) LIMIT 1) r ON true;
