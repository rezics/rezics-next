-- migrate:up
-- Account-free native disposition of an already committed complete output. No rule or private population.
CREATE TABLE library.collection_retained_output (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  source_generation bigint NOT NULL,
  members bigint NOT NULL CHECK(members >= 0),
  member_fence bigint NOT NULL,
  transaction_id uuid NOT NULL,
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  PRIMARY KEY(route,collection_id),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_source_output(route,collection_id,generation),
  FOREIGN KEY(partition_no,transaction_id)
    REFERENCES editorial.write_basis(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER collection_retained_output_immutable BEFORE UPDATE OR DELETE ON library.collection_retained_output
FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();

CREATE FUNCTION library.guard_frozen_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD; END IF;
  PERFORM 1 FROM library.collection WHERE route=item.route AND collection_id=item.collection_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM library.collection_retained_output r
    WHERE r.route=item.route AND r.collection_id=item.collection_id AND (TG_TABLE_NAME='collection_source_output_head' OR r.generation=item.generation)) THEN
    -- Only the terminal disposer may remove the private account attribution on the frozen header.
    IF TG_TABLE_NAME='collection_source_output' AND TG_OP='UPDATE' THEN
      IF NEW.account_id IS NULL AND OLD.account_id IS NOT NULL
        AND (to_jsonb(NEW)-'account_id')=(to_jsonb(OLD)-'account_id')
        AND EXISTS(SELECT 1 FROM access.account a WHERE a.route=OLD.route
          AND a.account_id=OLD.account_id AND a.state='deleted' AND a.authn_fenced)
      THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Frozen Collection output is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
CREATE TRIGGER collection_output_frozen_header BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output
FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();
CREATE TRIGGER collection_output_frozen_member BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output_member
FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();

CREATE TRIGGER collection_output_frozen_head BEFORE INSERT OR UPDATE OR DELETE ON library.collection_source_output_head
FOR EACH ROW EXECUTE FUNCTION library.guard_frozen_output();

-- migrate:down
-- Forward only: frozen output cannot regain private authorship or become writable.
