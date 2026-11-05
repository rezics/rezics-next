-- migrate:up
ALTER TABLE library.collection_source_output
  ADD COLUMN account_id uuid,
  ADD COLUMN member_count bigint NOT NULL DEFAULT 0 CHECK(member_count >= 0),
  ADD COLUMN member_fence bigint NOT NULL DEFAULT 0 CHECK(member_fence >= 0);
-- Historical output has no publication receipt. Preserve its rows without manufacturing provenance.
UPDATE library.collection_source_output g SET member_count=c.n
FROM (SELECT route,collection_id,generation,count(*) AS n
      FROM library.collection_source_output_member GROUP BY route,collection_id,generation) c
WHERE (g.route,g.collection_id,g.generation)=(c.route,c.collection_id,c.generation);

UPDATE library.collection_source_output g SET account_id=s.curator_account_id
FROM library.collection s WHERE s.route=g.route AND s.collection_id=g.collection_id;
CREATE INDEX collection_source_output_account ON library.collection_source_output(route,account_id,collection_id,generation);

CREATE FUNCTION library.track_output_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE library.collection_source_output SET member_count=member_count-1,member_fence=member_fence+1
    WHERE route=OLD.route AND collection_id=OLD.collection_id AND generation=OLD.generation;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE library.collection_source_output SET member_count=member_count+1,member_fence=member_fence+1
    WHERE route=NEW.route AND collection_id=NEW.collection_id AND generation=NEW.generation;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER collection_output_members AFTER INSERT OR UPDATE OR DELETE ON library.collection_source_output_member
FOR EACH ROW EXECUTE FUNCTION library.track_output_members();

-- A pending B does not invalidate selected A. Every selected mutation, including rekey/delete/restore,
-- fences both native anchors. Member mutations reach this hook through their actual generation counter.
CREATE FUNCTION library.fence_selected_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; step integer; attributed uuid;
BEGIN
  FOR step IN 1..2 LOOP
    IF step=1 THEN
      IF TG_OP='INSERT' THEN CONTINUE; END IF;
      item := OLD;
    ELSE
      IF TG_OP='DELETE' THEN CONTINUE; END IF;
      item := NEW;
    END IF;
    IF TG_TABLE_NAME='collection_source_output' AND NOT EXISTS (
      SELECT 1 FROM library.collection_source_output_head h
      WHERE h.route=item.route AND h.collection_id=item.collection_id AND h.generation=item.generation
    ) THEN CONTINUE; END IF;
    SELECT curator_account_id INTO attributed FROM library.collection
      WHERE route=item.route AND collection_id=item.collection_id;
    INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
    VALUES(item.route,'collection',item.collection_id,1,attributed)
    ON CONFLICT(route,kind,owner_id) DO UPDATE
      SET generation=library.native_source_fence.generation+1,
          account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id);
  END LOOP;
  RETURN NULL;
END; $$;
CREATE TRIGGER native_source_output_writer AFTER INSERT OR UPDATE OR DELETE ON library.collection_source_output
FOR EACH ROW EXECUTE FUNCTION library.fence_selected_output();
CREATE TRIGGER native_source_output_writer AFTER INSERT OR UPDATE OR DELETE ON library.collection_source_output_head
FOR EACH ROW EXECUTE FUNCTION library.fence_selected_output();

-- One native receipt per retained output, closed by the real Core command's write basis at commit.
-- A deferred FK permits the authorized hook to stage it before Core writes its fence and basis.
CREATE TABLE library.collection_source_output_publication (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  account_id uuid NOT NULL,
  incarnation text NOT NULL CHECK(octet_length(incarnation) BETWEEN 1 AND 128),
  source_generation bigint NOT NULL CHECK(source_generation > 0),
  expected_members bigint NOT NULL CHECK(expected_members >= 0),
  member_fence bigint NOT NULL CHECK(member_fence >= 0),
  collection_fence bigint NOT NULL CHECK(collection_fence >= 0),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  transaction_id uuid NOT NULL,
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY(route,collection_id,generation),
  FOREIGN KEY(route,collection_id,generation)
    REFERENCES library.collection_source_output(route,collection_id,generation),
  FOREIGN KEY(partition_no,transaction_id)
    REFERENCES editorial.write_basis(partition_no,transaction_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX collection_source_output_publication_account
ON library.collection_source_output_publication(route,account_id,collection_id,generation);
CREATE TRIGGER collection_output_publication_immutable BEFORE UPDATE ON library.collection_source_output_publication
FOR EACH ROW EXECUTE FUNCTION library.guard_native_source_receipt();

CREATE FUNCTION library.check_output_publication_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_publication r
    JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
    JOIN library.collection_source_output g USING(route,collection_id,generation)
    JOIN library.collection_source_output_head h USING(route,collection_id,generation)
    JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
    JOIN library.native_source_fence f ON f.route=r.route AND f.kind='collection' AND f.owner_id=r.collection_id
    WHERE r.route=NEW.route AND r.collection_id=NEW.collection_id AND r.generation=NEW.generation
      AND r.native_xid=pg_current_xact_id() AND r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
      AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL
      AND s.curator_account_id=r.account_id AND g.account_id=r.account_id AND s.state='active' AND s.visibility<>'private'
      AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
      AND s.source_generation=r.source_generation AND h.source_generation=r.source_generation
      AND g.source_generation+1=r.source_generation AND g.state='complete'
      AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
      AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
      AND f.generation=r.collection_fence
  ) THEN RAISE EXCEPTION 'collection_output_publication_uncommitted'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER collection_output_publication_commit AFTER INSERT ON library.collection_source_output_publication
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION library.check_output_publication_commit();

ALTER TABLE library.native_source_capture DROP CONSTRAINT native_source_capture_scope_check;
ALTER TABLE library.native_source_capture
  ADD COLUMN output_generation uuid,
  ADD COLUMN publication_transaction_id uuid,
  ADD COLUMN publication_position bigint,
  ADD CONSTRAINT native_source_capture_scope_check CHECK(scope IN ('curated','private_builtin','active_explicit_output')),
  ADD CONSTRAINT native_source_capture_output_binding CHECK (
    (scope='active_explicit_output' AND output_generation IS NOT NULL
      AND publication_transaction_id IS NOT NULL AND publication_position IS NOT NULL AND publication_position>0)
    OR (scope<>'active_explicit_output' AND output_generation IS NULL
      AND publication_transaction_id IS NULL AND publication_position IS NULL)
  );

-- migrate:down
-- Forward only: retained publication/capture provenance requires shared disposition, never timeout deletion.
