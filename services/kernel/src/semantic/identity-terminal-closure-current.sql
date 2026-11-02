SELECT g.partition_no,g.terminal,g.published_epoch,g.owner_epoch,g.generation,
 g.closure_state,g.closure_incarnation,requested.original AS requested_original,
 o.closure_state AS directory_state,o.closure_enrollment AS directory_enrollment,
 o.closure_incarnation AS directory_incarnation,o.closure_install_transaction AS directory_install,
 o.closure_export_transaction AS directory_export,o.closure_source_revision AS directory_revision,
 o.closure_source_epoch AS directory_owner,
 n.transaction_id AS registration_transaction,
 EXISTS(SELECT 1 FROM semantic.redirect r WHERE r.subject_id=g.terminal
   AND r.route=(get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11))) redirected
FROM unnest($1::integer[],$2::uuid[],$3::uuid[]) requested(partition_no,terminal,original)
JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(requested.partition_no,requested.terminal)
LEFT JOIN semantic.identity_epoch_original o ON (o.partition_no,o.generation,o.original)=(g.partition_no,g.generation,requested.original)
LEFT JOIN semantic.identity_epoch_native_commit n ON n.partition_no=o.partition_no
 AND n.transaction_id=o.closure_registration_transaction AND n.xmin::text=o.closure_registration_xid;
