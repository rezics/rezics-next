-- migrate:up
-- Nullable original provenance intentionally leaves earlier rows unverifiable.
ALTER TABLE semantic.public_filter_repair_advance
  ADD COLUMN transaction_id uuid,
  ADD COLUMN native_xid xid8,
  ADD CONSTRAINT public_filter_repair_advance_provenance CHECK
    ((transaction_id IS NULL) = (native_xid IS NULL));
ALTER TABLE semantic.public_filter_repair_step
  ADD COLUMN input_limit integer CHECK(input_limit BETWEEN 1 AND 256),
  ADD COLUMN receipt_protocol integer CHECK(receipt_protocol = 1),
  ADD CONSTRAINT public_filter_repair_step_provenance CHECK
    ((input_limit IS NULL) = (receipt_protocol IS NULL)),
  ADD CONSTRAINT public_filter_repair_predecessor FOREIGN KEY
    (partition_no,bootstrap,execution,predecessor)
    REFERENCES semantic.public_filter_repair_step(partition_no,bootstrap,execution,step);

CREATE FUNCTION semantic.validate_public_filter_repair_advance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_id IS NULL OR NEW.native_xid IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM core.partition p
      WHERE p.partition_no = NEW.partition_no AND p.epoch = NEW.owner_epoch
        AND p.position = NEW.position AND p.write_state = 'active'
        AND p.xmin = pg_current_xact_id()::xid
    ) OR NOT EXISTS (
      SELECT 1 FROM core.outbox e
      WHERE e.partition_no = NEW.partition_no AND e.position = NEW.position
        AND e.epoch = NEW.owner_epoch AND e.event_seq = 0 AND e.event_count = 1
        AND e.type = 'com.rezics.semantic.public-source.advanced.v1'
        AND e.subject = NEW.subject_id::text
        AND e.data = jsonb_build_object('id',NEW.subject_id::text,
          'bootstrap',NEW.bootstrap::text,'execution',NEW.execution)
        AND e.xmin = pg_current_xact_id()::xid
    ) THEN
    RAISE EXCEPTION 'Public Source advancement lacks original same-command native custody'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER public_filter_repair_advance_commit
  AFTER INSERT ON semantic.public_filter_repair_advance
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION semantic.validate_public_filter_repair_advance();
CREATE TRIGGER public_filter_repair_advance_immutable
  BEFORE UPDATE OR DELETE ON semantic.public_filter_repair_advance
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER public_filter_repair_step_immutable
  BEFORE UPDATE OR DELETE ON semantic.public_filter_repair_step
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


-- Keep only bounded ordered SHA-256 locators; old rows remain explicitly unverifiable.
ALTER TABLE semantic.public_filter_repair_step
  ADD COLUMN repair_locator_digests bytea,
  ADD CONSTRAINT public_filter_repair_locator_digests_bound CHECK
    (repair_locator_digests IS NULL OR
      (input_limit IS NOT NULL AND octet_length(repair_locator_digests) <= 8192
        AND mod(octet_length(repair_locator_digests),32) = 0
        AND octet_length(repair_locator_digests) / 32 <= input_limit));


-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Source repair provenance requires native retirement'; END $$;
