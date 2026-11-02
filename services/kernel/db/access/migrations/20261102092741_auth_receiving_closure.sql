-- migrate:up
-- Pending registration carries no physical authority, but its immutable Source
-- and barrier must still come from the native originals. Validate INSERT too,
-- including ON CONFLICT attempts, before a bad tuple can poison the permanent key.
CREATE FUNCTION access.auth_receiving_control_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM core.partition p JOIN access.auth_erasure_source s USING(partition_no)
 WHERE p.partition_no=NEW.partition_no AND p.write_state='active' AND s.initialized
 AND octet_length(s.source_owner)<=256 AND p.epoch=s.source_epoch AND p.node=s.source_owner
 AND s.generation=NEW.source_generation AND s.source_epoch=NEW.source_epoch AND s.source_owner=NEW.source_owner
 FOR SHARE OF p,s;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth receiving registration Source mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_control_source_guard BEFORE INSERT ON access.auth_receiving_control
 FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_control_source_guard();

CREATE FUNCTION access.auth_receiving_obligation_root_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM access.account a JOIN access.erasure e USING(route,account_id)
 JOIN access.auth_erasure_obligation o USING(route,account_id)
 WHERE a.route=NEW.route AND a.account_id=NEW.account_id AND NEW.partition_no=NEW.route/16
 AND a.state='deleted' AND a.authn_fenced AND o.minimum_authn_epoch IS NOT NULL
 AND a.minimum_authn_epoch>=o.minimum_authn_epoch AND e.version=NEW.version AND e.at=NEW.at
 AND o.version=e.version AND o.at=e.at FOR SHARE OF a,e,o;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Auth receiving registration barrier mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_obligation_root_guard BEFORE INSERT ON access.auth_receiving_obligation
 FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_obligation_root_guard();

-- migrate:down
-- Forward-only original Source and barrier validation; no historical backfill.
