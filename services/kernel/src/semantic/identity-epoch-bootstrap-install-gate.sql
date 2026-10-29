WITH parameters AS (SELECT $1::integer home,$2::uuid terminal,$3::uuid original,$4::uuid transaction_id)
INSERT INTO semantic.identity_epoch_home_gate(route,destination,original,terminal,epoch,recorded_transaction_id)
SELECT get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11),g.terminal,
 (SELECT original FROM parameters),g.terminal,g.published_epoch,(SELECT transaction_id FROM parameters)
FROM semantic.identity_epoch_group g WHERE g.partition_no=(SELECT home FROM parameters)
 AND g.terminal=(SELECT terminal FROM parameters) AND g.pending_job IS NULL
ON CONFLICT(route,destination,original) DO UPDATE SET terminal=excluded.terminal,epoch=excluded.epoch,
 pending_job=NULL,pending_epoch=NULL,recorded_transaction_id=excluded.recorded_transaction_id;
