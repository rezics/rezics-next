-- migrate:up
ALTER TABLE content.moderation_decision ALTER COLUMN decider_account_id DROP NOT NULL;
ALTER TABLE content.moderation_decision DROP CONSTRAINT moderation_decision_statement_check;
ALTER TABLE content.moderation_decision ADD CONSTRAINT moderation_decision_statement_check
  CHECK (char_length(statement) BETWEEN 0 AND 1024);
ALTER TABLE content.operation
  ALTER COLUMN initiator_account_id DROP NOT NULL,
  ALTER COLUMN author_account_id DROP NOT NULL,
  ALTER COLUMN actor_account_id DROP NOT NULL,
  ALTER COLUMN actor_client_id DROP NOT NULL;

-- Source commitments remain immutable. The only additional transition is
-- irreversible removal of party details after the native workflow terminates.
CREATE OR REPLACE FUNCTION content.guard_operation_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Operation identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW.native_workflow_id, NEW.source_epoch, NEW.source_partition,
        NEW.source_position, NEW.source_event_index) <> 0 THEN
      RAISE EXCEPTION 'Operation source is bound only after recording' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index']) THEN
      IF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index',
          'initiator_account_id','author_account_id','actor_account_id','original_operator_account_id','actor_client_id','actor_requested_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index',
          'initiator_account_id','author_account_id','actor_account_id','original_operator_account_id','actor_client_id','actor_requested_by'])
        OR (NEW.initiator_account_id IS NOT NULL AND NEW.initiator_account_id IS DISTINCT FROM OLD.initiator_account_id)
        OR (NEW.author_account_id IS NOT NULL AND NEW.author_account_id IS DISTINCT FROM OLD.author_account_id)
        OR (NEW.actor_account_id IS NOT NULL AND NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id)
        OR (NEW.original_operator_account_id IS NOT NULL AND NEW.original_operator_account_id IS DISTINCT FROM OLD.original_operator_account_id)
        OR (NEW.actor_client_id IS NOT NULL AND NEW.actor_client_id IS DISTINCT FROM OLD.actor_client_id)
        OR (NEW.actor_requested_by IS NOT NULL AND NEW.actor_requested_by IS DISTINCT FROM OLD.actor_requested_by)
        OR OLD.native_workflow_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=OLD.native_workflow_id
          AND status IN ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')) THEN
        RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF OLD.native_workflow_id IS NOT NULL AND ROW(NEW.native_workflow_id, NEW.source_epoch,
        NEW.source_partition, NEW.source_position, NEW.source_event_index) IS DISTINCT FROM
        ROW(OLD.native_workflow_id, OLD.source_epoch, OLD.source_partition, OLD.source_position, OLD.source_event_index) THEN
      RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A delayed outcome projection must preserve an anonymized decision's outcome
-- without recreating the moderator identity in a report.
ALTER TABLE content.report DROP CONSTRAINT report_outcome_shape;
ALTER TABLE content.report ADD CONSTRAINT report_outcome_shape CHECK (
  (outcome IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND decision_id IS NULL)
  OR (outcome IS NOT NULL AND outcome IN ('actioned','dismissed') AND resolved_at IS NOT NULL
    AND ((outcome='actioned' AND decision_id IS NOT NULL)
      OR (outcome='dismissed' AND decision_id IS NULL AND resolved_by IS NOT NULL)))
);

CREATE TABLE content.party_locator (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decision','operation')),
  due_at timestamptz NOT NULL CHECK (isfinite(due_at)),
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535),
  owner_id uuid NOT NULL,
  PRIMARY KEY (route,account_id,kind,due_at,owner_id),
  CHECK (route = get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
  CHECK (owner_route = get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11))
);
INSERT INTO content.party_locator(route,account_id,kind,due_at,owner_route,owner_id)
SELECT get_byte(uuid_send(decider_account_id),10)*256+get_byte(uuid_send(decider_account_id),11),
  decider_account_id,'decision',decided_at+interval '183 days',route,decision_id
FROM content.moderation_decision WHERE decider_account_id IS NOT NULL;
INSERT INTO content.party_locator(route,account_id,kind,due_at,owner_route,owner_id)
SELECT DISTINCT get_byte(uuid_send(party),10)*256+get_byte(uuid_send(party),11),party,
  'operation',requested_at,route,operation_id
FROM content.operation CROSS JOIN LATERAL unnest(ARRAY[initiator_account_id,author_account_id,actor_account_id,
  original_operator_account_id,split_part(actor_requested_by,':',4)::uuid]) AS parties(party)
WHERE party IS NOT NULL ON CONFLICT DO NOTHING;

-- migrate:down
DROP TABLE content.party_locator;
-- Erased identities and statements cannot be reconstructed by a rollback.
