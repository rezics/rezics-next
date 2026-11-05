-- migrate:up
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody',
 'identity-prearm','identity-prearm-cancel',
 'identity-scope-registration','identity-scope-enrollment','identity-scope-preparation','identity-scope-cancellation',
 'identity-public-capture','identity-scope-finish','identity-scope-retirement','identity-scope-directory-release'));
CREATE OR REPLACE FUNCTION semantic.guard_identity_scope_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_scope_bridge;
BEGIN
 IF NEW.pending_job IS NULL OR (NEW.pending_job,NEW.pending_epoch) IS NOT DISTINCT FROM
 (OLD.pending_job,OLD.pending_epoch) THEN RETURN NEW; END IF;
 INSERT INTO semantic.identity_scope_bridge(partition_no,generation)
 VALUES(NEW.partition_no,'00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING;
 FOR b IN SELECT * FROM semantic.identity_scope_bridge
 WHERE partition_no=NEW.partition_no AND generation IN
 (NEW.generation,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY generation FOR UPDATE LOOP
  -- Advance even an empty prefix: later enrollment cannot miss a committed prior claim
  -- through a SERIALIZABLE snapshot taken before this bridge lock was available.
  UPDATE semantic.identity_scope_bridge SET version=version+1
  WHERE partition_no=b.partition_no AND generation=b.generation;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_scope_inverse i WHERE i.partition_no=b.partition_no AND i.generation=b.generation LIMIT 1) THEN CONTINUE; END IF;
  IF b.generation=NEW.generation THEN
   -- The delivered admission producer sealed this exact native inverse generation.
   -- Its bounded export already resolved every Source PREPARATION receipt.
   IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_prearm_directory d
    JOIN semantic.identity_epoch_prearm_bridge n USING(partition_no,generation)
    JOIN semantic.identity_epoch_native_commit c ON c.partition_no=d.partition_no
     AND c.transaction_id=d.sealed_transaction_id AND c.xmin=d.xmin AND c.purpose='identity-prearm'
    JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
     AND p.position>=c.position AND p.write_state='active' AND p.moved_to IS NULL
    WHERE d.partition_no=NEW.partition_no AND d.generation=NEW.generation
     AND d.job_id=NEW.pending_job AND d.job_epoch=NEW.pending_epoch AND NOT d.released
     AND d.exhausted AND d.owner_epoch=NEW.owner_epoch AND d.basis_version=OLD.version
     AND n.job_id=d.job_id AND n.job_epoch=d.job_epoch AND n.scope_digest=d.scope_digest
     AND n.owner_epoch=d.owner_epoch AND n.basis_version=d.basis_version)
   THEN RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001'; END IF;
  ELSIF b.closed_job IS DISTINCT FROM NEW.pending_job OR b.closed_epoch IS DISTINCT FROM NEW.pending_epoch
   OR b.seal_transaction IS NULL THEN
   RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- The Source's retained forward receipt must also cover the delivered admission inverse.
-- Re-enroll old committed original tickets before exposing a clean Source summary again.
UPDATE semantic.identity_scope_forward f SET directory_group=m.terminal
 FROM semantic.identity_epoch_original m
 WHERE f.original=m.original AND f.directory_home=m.partition_no
  AND f.directory_generation=m.generation AND f.ticket IS NOT NULL;
UPDATE semantic.identity_scope_forward SET ticket=NULL WHERE original IS NOT NULL;
UPDATE semantic.identity_scope_summary s SET revision=revision+1,
 state=CASE WHEN active=0 AND scan_complete THEN 'enrolling' ELSE 'repair' END
 WHERE state NOT IN ('retiring','retired') AND EXISTS(SELECT 1 FROM semantic.identity_scope_forward f
  WHERE f.partition_no=s.partition_no AND f.source_key=s.source_key AND f.scope_id=s.scope_id
   AND f.registration=s.registration AND f.original IS NOT NULL);

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.guard_identity_scope_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_scope_bridge;
BEGIN
 IF NEW.pending_job IS NULL OR (NEW.pending_job,NEW.pending_epoch) IS NOT DISTINCT FROM
 (OLD.pending_job,OLD.pending_epoch) THEN RETURN NEW; END IF;
 INSERT INTO semantic.identity_scope_bridge(partition_no,generation)
 VALUES(NEW.partition_no,'00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING;
 FOR b IN SELECT * FROM semantic.identity_scope_bridge
 WHERE partition_no=NEW.partition_no AND generation IN
 (NEW.generation,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY generation FOR UPDATE LOOP
  -- Advance even an empty prefix: later enrollment cannot miss a committed prior claim
  -- through a SERIALIZABLE snapshot taken before this bridge lock was available.
  UPDATE semantic.identity_scope_bridge SET version=version+1
  WHERE partition_no=b.partition_no AND generation=b.generation;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_scope_inverse i WHERE i.partition_no=b.partition_no AND i.generation=b.generation LIMIT 1) THEN CONTINUE; END IF;
  IF b.closed_job IS DISTINCT FROM NEW.pending_job OR b.closed_epoch IS DISTINCT FROM NEW.pending_epoch
   OR b.seal_transaction IS NULL THEN
   RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
