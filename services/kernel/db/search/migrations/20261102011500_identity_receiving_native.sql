-- migrate:up
-- An operational queue, not a claim that Source has discovered the complete population.
-- Enqueue in the very transaction that admits a common Search plan. In particular a later
-- lower-sorting effect must not disappear behind a participant's scheduling frontier.
CREATE TABLE search.identity_receiving_native_scope_pending (
 partition_no integer NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL CHECK (job_epoch > 0),
 effect_key text COLLATE "C" NOT NULL,
 plan_transaction_id uuid NOT NULL,
 PRIMARY KEY (partition_no,job_id,job_epoch,effect_key),
 FOREIGN KEY (partition_no,job_id,effect_key)
  REFERENCES semantic.identity_epoch_receiving_plan(partition_no,job_id,effect_key)
);
CREATE FUNCTION search.enqueue_identity_receiving_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.binding->>'step'='search-canonical-index' THEN
  INSERT INTO search.identity_receiving_native_scope_pending
   (partition_no,job_id,job_epoch,effect_key,plan_transaction_id)
  VALUES (NEW.partition_no,NEW.job_id,NEW.job_epoch,NEW.effect_key,NEW.transaction_id);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_receiving_scope_pending AFTER INSERT ON semantic.identity_epoch_receiving_plan
 FOR EACH ROW EXECUTE FUNCTION search.enqueue_identity_receiving_scope();
-- Previously admitted plans conservatively restart through exact accepted/released replay.
INSERT INTO search.identity_receiving_native_scope_pending
 (partition_no,job_id,job_epoch,effect_key,plan_transaction_id)
SELECT partition_no,job_id,job_epoch,effect_key,transaction_id
FROM semantic.identity_epoch_receiving_plan WHERE binding->>'step'='search-canonical-index';

-- migrate:down
DROP TRIGGER identity_receiving_scope_pending ON semantic.identity_epoch_receiving_plan;
DROP FUNCTION search.enqueue_identity_receiving_scope();
DROP TABLE search.identity_receiving_native_scope_pending;
