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
  native_xid xid8 NOT NULL,
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  PRIMARY KEY(route,collection_id),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_source_output(route,collection_id,generation),
  FOREIGN KEY(partition_no,transaction_id)
    REFERENCES editorial.write_basis(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED
);
-- Terminal maintenance has no human command basis. Preserve A's original real
-- publication proof only after checking it while the terminal owner is locked.
CREATE FUNCTION library.guard_retained_output_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM library.collection WHERE route=NEW.route AND collection_id=NEW.collection_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_publication r
    JOIN library.collection_source_output_head h USING(route,collection_id,generation)
    JOIN library.collection_source_output g USING(route,collection_id,generation)
    JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
    JOIN access.account a ON a.route=s.route AND a.account_id=s.curator_account_id
    JOIN library.native_source_fence f ON f.route=r.route AND f.kind='collection' AND f.owner_id=r.collection_id
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
    WHERE (r.route,r.collection_id,r.generation,r.transaction_id,r.native_xid,r.source_generation,r.expected_members,r.member_fence)=
      (NEW.route,NEW.collection_id,NEW.generation,NEW.transaction_id,NEW.native_xid,NEW.source_generation,NEW.members,NEW.member_fence)
      AND a.state='deleted' AND a.authn_fenced AND s.state='active' AND s.visibility='public'
      AND s.membership_kind='dynamic' AND s.source_generation=r.source_generation
      AND h.source_generation=r.source_generation AND g.source_generation+1=r.source_generation
      AND s.curator_account_id=r.account_id AND g.account_id=r.account_id
      AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
      AND f.generation=r.collection_fence AND g.state='complete'
      AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
      AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
      AND r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
      AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
      AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL
  ) THEN RAISE EXCEPTION 'Retained output requires terminal ownership and committed complete A' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER collection_retained_output_insert BEFORE INSERT ON library.collection_retained_output
FOR EACH ROW EXECUTE FUNCTION library.guard_retained_output_insert();
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
