-- The owner row is locked first. All seven disjoint components become spent atomically.
WITH input AS MATERIALIZED (SELECT :original_key::text AS key,:transaction_id::uuid AS transaction_id),
owner AS MATERIALIZED (
 SELECT original_key,admitted FROM semantic.definition_catalogue_original
 WHERE route=0 AND original_key=(SELECT key FROM input) AND state='admitted'
 AND deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint FOR UPDATE
), tickets AS MATERIALIZED (
 SELECT slot,allowance FROM semantic.definition_catalogue_ticket
 WHERE route=0 AND original_key=(SELECT key FROM input) AND state='admitted' ORDER BY slot FOR UPDATE
), valid AS MATERIALIZED (
 SELECT o.original_key FROM owner o WHERE (SELECT count(*) FROM tickets)=7
 AND NOT EXISTS (SELECT 1 FROM generate_series(1,8) n
  WHERE o.admitted[n]<>(SELECT sum(allowance[n]) FROM tickets))
), spent AS (
 UPDATE semantic.definition_catalogue_ticket SET state='spent',dispatch_transaction_id=(SELECT transaction_id FROM input)
 WHERE route=0 AND original_key=(SELECT original_key FROM valid) AND state='admitted' RETURNING slot
), changed AS (
 UPDATE semantic.definition_catalogue_original SET state='spent',spent=admitted,
 dispatch_transaction_id=(SELECT transaction_id FROM input)
 WHERE route=0 AND original_key=(SELECT original_key FROM valid) AND (SELECT count(*) FROM spent)=7
 RETURNING original_key,dispatch_transaction_id
) SELECT original_key,dispatch_transaction_id FROM changed LIMIT 1;
