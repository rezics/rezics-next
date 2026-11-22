-- migrate:up
CREATE FUNCTION semantic.erasure_retained_role_position(p_home integer, p_tx uuid, p_recorded bigint, p_delivery bigint) RETURNS bigint
    LANGUAGE sql STABLE STRICT
    AS $$
 WITH original AS MATERIALIZED (SELECT coalesce(
   (SELECT position FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx),
   (SELECT position FROM semantic.erasure_source_commit WHERE partition_no=p_home AND transaction_id=p_tx),
   (SELECT position FROM semantic.identity_epoch_native_commit WHERE partition_no=p_home AND transaction_id=p_tx),
   -- Only the write_basis producer captures this key, always from the original basis position.
   (SELECT CASE WHEN r.native_present THEN r.source_position END FROM semantic.erasure_provenance p
     CROSS JOIN LATERAL (
       SELECT account_id,role FROM semantic.erasure_locator
       WHERE partition_no=p_home AND source_transaction_id=p_tx AND store='write_basis' AND record_key=p.record_key
       LIMIT 1
     ) l JOIN semantic.erasure_source_record r ON r.partition_no=p_home AND r.account_id=l.account_id AND r.role=l.role
       AND r.store='write_basis' AND r.record_key=p.record_key AND coalesce(r.source_transaction_id::text,'')=p_tx::text
     WHERE p.partition_no=p_home AND p.transaction_id=p_tx AND p.minimized
     LIMIT 1)
 ) AS position)
 SELECT position FROM original WHERE position=p_recorded OR (p_recorded=p_delivery AND position<p_delivery);
$$;

-- migrate:down
DROP FUNCTION semantic.erasure_retained_role_position(integer,uuid,bigint,bigint);
