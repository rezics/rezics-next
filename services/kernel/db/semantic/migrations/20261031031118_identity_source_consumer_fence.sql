-- migrate:up
-- Forward native binding provenance only. Historical claims have no undo counter;
-- neither deployment time nor the current owner can reconstruct their consumers.
ALTER TABLE semantic.identity_epoch_receipt_binding
 ADD COLUMN consumer_undo_generation bigint CHECK(consumer_undo_generation>=0),
 ADD COLUMN consumer_undo_transaction_id uuid,
 ADD COLUMN consumer_terminal_custody bigint,
 ADD COLUMN consumer_terminal_sequence bigint CHECK(consumer_terminal_sequence>0),
 ADD CONSTRAINT identity_binding_consumer_undo_pair CHECK
  ((consumer_undo_generation IS NULL)=(consumer_undo_transaction_id IS NULL)),
 ADD CONSTRAINT identity_binding_consumer_terminal_pair CHECK
  ((consumer_terminal_custody IS NULL)=(consumer_terminal_sequence IS NULL)),
 ADD CONSTRAINT identity_binding_consumer_undo_commit FOREIGN KEY(partition_no,consumer_undo_transaction_id)
  REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id);

-- A native claim command records one claim. The exact command lookup below must
-- not scan the account's retained claim history. Imported claims confer no counter.
CREATE UNIQUE INDEX identity_receipt_claim_native_command
 ON semantic.identity_epoch_receipt_claim(partition_no,transaction_id) WHERE NOT imported;

-- Original immutable admission fields retain their original protection. The only
-- additional mutations name a real same-command reversal claim or Source terminal
-- row. These counters and pointers are fences, never terminal receipt authority.
CREATE OR REPLACE FUNCTION semantic.keep_identity_epoch_accepted_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unchanged boolean; native_terminal boolean;
BEGIN
 unchanged := (to_jsonb(NEW)-ARRAY['consumer_undo_generation','consumer_undo_transaction_id',
  'consumer_terminal_custody','consumer_terminal_sequence']) =
  (to_jsonb(OLD)-ARRAY['consumer_undo_generation','consumer_undo_transaction_id',
  'consumer_terminal_custody','consumer_terminal_sequence']);
 IF OLD.state='accepted' AND NEW IS DISTINCT FROM OLD THEN
  IF NOT unchanged THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  IF (NEW.consumer_undo_generation,NEW.consumer_undo_transaction_id) IS DISTINCT FROM
     (OLD.consumer_undo_generation,OLD.consumer_undo_transaction_id) THEN
   IF OLD.consumer_terminal_custody IS NOT NULL OR OLD.consumer_undo_generation IS NULL
    OR NEW.consumer_undo_generation IS DISTINCT FROM OLD.consumer_undo_generation+1
    OR NEW.consumer_undo_transaction_id IS NOT DISTINCT FROM OLD.consumer_undo_transaction_id
    OR (NEW.consumer_terminal_custody,NEW.consumer_terminal_sequence) IS DISTINCT FROM
       (OLD.consumer_terminal_custody,OLD.consumer_terminal_sequence)
    OR NOT EXISTS(
      SELECT 1 FROM semantic.identity_epoch_receipt_claim c
      JOIN semantic.identity_epoch_native_commit n ON n.partition_no=c.partition_no
       AND n.transaction_id=c.transaction_id AND n.purpose='admission' AND n.xmin=c.xmin
      JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
       AND p.write_state='active' AND p.moved_to IS NULL AND n.position=p.position+1
      WHERE c.partition_no=OLD.partition_no AND c.transaction_id=NEW.consumer_undo_transaction_id AND NOT c.imported
       AND c.xmin=pg_current_xact_id()::xid AND c.receipt->>'kind'='account-agent.unverify'
       AND c.receipt->>'account'=OLD.account_id::text AND c.intent->>'kind'='unmerge'
       AND c.intent->'undoJob'->>'jobId'=OLD.accepted_job::text
       AND c.intent->'undoJob'->>'epoch'=OLD.accepted_epoch::text
       AND OLD.receipt_key::jsonb=jsonb_build_array('account-agent.verify',OLD.account_id::text,
         c.intent->>'verificationReceipt')
    ) THEN RAISE EXCEPTION 'identity_consumer_undo_not_native'; END IF;
  ELSE
   IF OLD.consumer_terminal_custody IS NOT NULL OR NEW.consumer_terminal_custody IS NULL
    OR to_regclass('semantic.identity_epoch_source_consumer_terminal') IS NULL THEN
    RAISE EXCEPTION 'identity_consumer_terminal_not_native';
   END IF;
   EXECUTE $q$SELECT EXISTS(
    SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
    JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
     AND r.erasure_key=t.custody_key
    JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
     AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
    JOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=r.partition_no
     AND k.receipt_key=r.receipt_key AND k.generation=r.binding_generation
     AND k.transaction_id=r.binding_transaction_id
    JOIN semantic.identity_epoch_native_commit original ON original.partition_no=k.partition_no
     AND original.transaction_id=k.transaction_id AND original.purpose='admission' AND original.xmin=k.xmin
    JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
     AND p.write_state='active' AND p.moved_to IS NULL AND n.position=p.position+1
    WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3
     AND t.state IN ('transferred','discharged') AND t.xmin=pg_current_xact_id()::xid
     AND r.receipt_key=$4 AND r.binding_generation=$5 AND r.source_digest=$6
     AND r.job_id=$7 AND r.job_epoch=$8 AND t.replay_generation=$5
     AND t.undo_generation=$9 AND t.restore_generation=original.epoch
   )$q$ INTO native_terminal USING OLD.partition_no,NEW.consumer_terminal_custody,
    NEW.consumer_terminal_sequence,OLD.receipt_key,OLD.generation,OLD.intent_digest,
    OLD.accepted_job,OLD.accepted_epoch,OLD.consumer_undo_generation;
   IF NOT native_terminal THEN RAISE EXCEPTION 'identity_consumer_terminal_not_native'; END IF;
  END IF;
 END IF;
 IF (OLD.partition_no,OLD.receipt_key,OLD.account_id,OLD.intent_digest) IS DISTINCT FROM
    (NEW.partition_no,NEW.receipt_key,NEW.account_id,NEW.intent_digest) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 RETURN NEW;
END $$;

-- New native claims initialize their own provenance. Acceptance of a historical
-- claim deliberately leaves NULL; no backfill or migration-time reconstruction.
CREATE FUNCTION semantic.validate_identity_binding_consumer_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
 IF NEW.consumer_undo_generation IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_receipt_claim c
  JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
  JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
   AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
  WHERE c.partition_no=NEW.partition_no AND c.receipt_key=NEW.receipt_key AND c.generation=NEW.generation
   AND c.transaction_id=n.transaction_id AND n.transaction_id=NEW.consumer_undo_transaction_id
   AND c.xmin=pg_current_xact_id()::xid AND NEW.consumer_undo_generation=0
 ) THEN RAISE EXCEPTION 'identity_consumer_birth_not_native'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER identity_binding_consumer_birth AFTER INSERT OR UPDATE ON semantic.identity_epoch_receipt_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.validate_identity_binding_consumer_birth();

CREATE FUNCTION semantic.bind_identity_source_consumer_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_receipt_key text;
BEGIN
 IF NEW.state NOT IN ('transferred','discharged') THEN RETURN NEW; END IF;
 SELECT r.receipt_key INTO v_receipt_key FROM semantic.identity_epoch_source_consumer_custody r
  WHERE r.partition_no=NEW.partition_no AND r.erasure_key=NEW.custody_key;
 UPDATE semantic.identity_epoch_receipt_binding b
  SET consumer_terminal_custody=NEW.custody_key,consumer_terminal_sequence=NEW.sequence
  WHERE b.partition_no=NEW.partition_no AND b.receipt_key=v_receipt_key
   AND b.consumer_terminal_custody IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'identity_consumer_terminal_binding_changed'; END IF;
 RETURN NEW;
END $$;

-- The sole Source owner delivers this table. Do not duplicate its schema here.
-- Normal producer-first migration ordering installs the hook when that delivery
-- is integrated. Until then the local cut explicitly refuses to finalize.
DO $$ BEGIN
 IF to_regclass('semantic.identity_epoch_source_consumer_terminal') IS NOT NULL THEN
  EXECUTE 'CREATE TRIGGER identity_source_consumer_binding_fence AFTER INSERT
   ON semantic.identity_epoch_source_consumer_terminal FOR EACH ROW
   EXECUTE FUNCTION semantic.bind_identity_source_consumer_terminal()';
 END IF;
END $$;
CREATE FUNCTION semantic.identity_source_consumer_terminal_hook_installed() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
  AND tgrelid=to_regclass('semantic.identity_epoch_source_consumer_terminal')
  AND tgname='identity_source_consumer_binding_fence'
  AND tgfoid='semantic.bind_identity_source_consumer_terminal()'::regprocedure);
$$;

-- A replay verifier resolves the exact Source-owned terminal and its original
-- barrier/role, not another terminal for the same binding or a copied disposition.
CREATE FUNCTION semantic.identity_source_consumer_terminal_matches(
 p_home integer,p_custody bigint,p_sequence bigint,p_reference jsonb,p_generation jsonb,p_tx uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 IF NOT semantic.identity_source_consumer_terminal_hook_installed() THEN RETURN false; END IF;
 EXECUTE $q$SELECT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
  JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
   AND r.erasure_key=t.custody_key
  JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
   AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.write_state='active' AND p.moved_to IS NULL
   AND (p.position>=n.position OR (n.transaction_id=$6 AND n.position=p.position+1))
  WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3 AND t.state='transferred'
   AND r.receipt_key::jsonb=jsonb_build_array($4#>>'{receipt,kind}',$4#>>'{receipt,account}',$4#>>'{receipt,receipt}')
   AND r.source_digest=$4->>'sourceDigest' AND r.source_epoch::text=$4#>>'{source,epoch}'
   AND r.source_position::text=$4#>>'{source,position}' AND r.source_transaction_id::text=$4#>>'{source,transactionId}'
   AND r.job_id::text=$4#>>'{job,jobId}' AND r.job_epoch::text=$4#>>'{job,epoch}'
   AND r.barrier_account_id::text=$4#>>'{barrier,accountId}'
   AND r.barrier_account_route::text=$4#>>'{barrier,accountRoute}'
   AND r.barrier_version::text=$4#>>'{barrier,version}' AND r.barrier_at=($4#>>'{barrier,at}')::timestamptz
   AND r.erased_role=$4->>'erasedRole' AND r.binding_generation=t.replay_generation
   AND t.replay_generation::text=$5->>'replayGeneration'
   AND t.undo_generation::text=$5->>'undoGeneration' AND t.restore_generation::text=$5->>'restoreGeneration'
 )$q$ INTO matched USING p_home,p_custody,p_sequence,p_reference,p_generation,p_tx;
 RETURN matched;
END $$;

-- migrate:down
DROP FUNCTION semantic.identity_source_consumer_terminal_matches(integer,bigint,bigint,jsonb,jsonb,uuid);
DO $$ BEGIN
 IF to_regclass('semantic.identity_epoch_source_consumer_terminal') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS identity_source_consumer_binding_fence ON semantic.identity_epoch_source_consumer_terminal';
 END IF;
END $$;
DROP FUNCTION semantic.identity_source_consumer_terminal_hook_installed();
DROP FUNCTION semantic.bind_identity_source_consumer_terminal();
DROP TRIGGER identity_binding_consumer_birth ON semantic.identity_epoch_receipt_binding;
DROP FUNCTION semantic.validate_identity_binding_consumer_birth();
DROP INDEX semantic.identity_receipt_claim_native_command;
CREATE OR REPLACE FUNCTION semantic.keep_identity_epoch_accepted_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='accepted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 IF (OLD.partition_no,OLD.receipt_key,OLD.account_id,OLD.intent_digest) IS DISTINCT FROM
    (NEW.partition_no,NEW.receipt_key,NEW.account_id,NEW.intent_digest) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE semantic.identity_epoch_receipt_binding
 DROP COLUMN consumer_terminal_sequence,DROP COLUMN consumer_terminal_custody,
 DROP COLUMN consumer_undo_transaction_id,DROP COLUMN consumer_undo_generation;
