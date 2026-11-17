-- migrate:up
CREATE TABLE community.space_discovery_readiness_change (
  authority smallint NOT NULL CHECK (authority IN (0,1)),
  partition_no integer NOT NULL CHECK (partition_no BETWEEN -1 AND 4095),
  transaction_id xid8 NOT NULL,
  PRIMARY KEY (authority,partition_no)
);
CREATE INDEX space_discovery_readiness_change_transaction
  ON community.space_discovery_readiness_change(transaction_id);

-- Each authority row has its own marker. An overwrite retains evidence of a
-- later commit even if that writer obtained its transaction ID earlier.
CREATE FUNCTION community.mark_space_discovery_readiness_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  p := CASE TG_OP
    WHEN 'TRUNCATE' THEN -1 WHEN 'DELETE' THEN OLD.partition_no ELSE NEW.partition_no
  END;
  INSERT INTO community.space_discovery_readiness_change AS change(authority,partition_no,transaction_id)
  VALUES(TG_ARGV[0]::smallint,p,pg_current_xact_id())
  ON CONFLICT (authority,partition_no) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
    WHERE change.transaction_id<>EXCLUDED.transaction_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER space_discovery_install_readiness_change
  AFTER INSERT OR UPDATE OR DELETE ON community.space_discovery_dependency_install
  FOR EACH ROW EXECUTE FUNCTION community.mark_space_discovery_readiness_change('0');
CREATE TRIGGER space_discovery_install_readiness_truncate
  AFTER TRUNCATE ON community.space_discovery_dependency_install
  FOR EACH STATEMENT EXECUTE FUNCTION community.mark_space_discovery_readiness_change('0');
CREATE TRIGGER space_discovery_capability_readiness_change
  AFTER INSERT OR UPDATE OR DELETE ON community.space_discovery_tuple_capability
  FOR EACH ROW EXECUTE FUNCTION community.mark_space_discovery_readiness_change('1');
CREATE TRIGGER space_discovery_capability_readiness_truncate
  AFTER TRUNCATE ON community.space_discovery_tuple_capability
  FOR EACH STATEMENT EXECUTE FUNCTION community.mark_space_discovery_readiness_change('1');

ALTER TABLE community.space_discovery_dependency_install
  ENABLE ALWAYS TRIGGER space_discovery_install_readiness_change,
  ENABLE ALWAYS TRIGGER space_discovery_install_readiness_truncate;
ALTER TABLE community.space_discovery_tuple_capability
  ENABLE ALWAYS TRIGGER space_discovery_capability_readiness_change,
  ENABLE ALWAYS TRIGGER space_discovery_capability_readiness_truncate;

-- migrate:down
DROP TRIGGER space_discovery_install_readiness_change ON community.space_discovery_dependency_install;
DROP TRIGGER space_discovery_install_readiness_truncate ON community.space_discovery_dependency_install;
DROP TRIGGER space_discovery_capability_readiness_change ON community.space_discovery_tuple_capability;
DROP TRIGGER space_discovery_capability_readiness_truncate ON community.space_discovery_tuple_capability;
DROP FUNCTION community.mark_space_discovery_readiness_change();
DROP TABLE community.space_discovery_readiness_change;
