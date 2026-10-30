INSERT INTO semantic.record_source_set(partition_no,transaction_id)
VALUES(:partition::integer,:transaction::uuid)
RETURNING revision::double precision AS revision;
