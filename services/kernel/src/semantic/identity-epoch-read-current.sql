SELECT g.partition_no,g.terminal,g.published_epoch,g.owner_epoch,
 EXISTS(SELECT 1 FROM semantic.redirect r WHERE r.subject_id=g.terminal
   AND r.route=(get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11))) redirected
FROM unnest($1::integer[],$2::uuid[]) requested(partition_no,terminal)
JOIN LATERAL(SELECT * FROM semantic.identity_epoch_group WHERE (partition_no,terminal)=(requested.partition_no,requested.terminal) LIMIT 1) g ON true;
