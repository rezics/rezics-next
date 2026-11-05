-- migrate:up
-- NULL on previously released rows is intentional: original release cannot be reconstructed.
ALTER TABLE semantic.identity_epoch_prearm_directory ADD COLUMN release_transaction_id uuid;
ALTER TABLE semantic.identity_epoch_prearm_directory
 ADD CONSTRAINT identity_prearm_release_commit_fkey FOREIGN KEY(partition_no,release_transaction_id)
 REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id);
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody',
 'identity-prearm','identity-prearm-cancel',
 'identity-scope-registration','identity-scope-enrollment','identity-scope-preparation','identity-scope-cancellation',
 'identity-public-capture','identity-scope-finish','identity-scope-retirement','identity-scope-directory-release',
 'identity-prearm-release'));

-- Release is also the retained directory fence. Any later page writer, including erasure
-- minimization, touches that directory in its SAME transaction. Its xmin then no longer
-- matches the original native release component; a retained cut must become unavailable.
-- This does not clear the original locator, reopen a gate, or mint a replacement receipt.
CREATE FUNCTION semantic.invalidate_identity_prearm_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  UPDATE semantic.identity_epoch_prearm_directory SET released=released
   WHERE partition_no=OLD.partition_no AND job_id=OLD.job_id AND generation=OLD.generation AND released;
 END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND
  (NEW.partition_no,NEW.job_id,NEW.generation) IS DISTINCT FROM (OLD.partition_no,OLD.job_id,OLD.generation)) THEN
  UPDATE semantic.identity_epoch_prearm_directory SET released=released
   WHERE partition_no=NEW.partition_no AND job_id=NEW.job_id AND generation=NEW.generation AND released;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER identity_prearm_release_fence AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_prearm_page
 FOR EACH ROW EXECUTE FUNCTION semantic.invalidate_identity_prearm_release();

-- migrate:down
-- Forward only: retained original release provenance must not be discarded.
