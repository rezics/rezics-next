-- A ban appeal is a governance case for one realm ban receipt. Content and rights
-- cases cannot name a membership sanction, so the case checks gain one kind and
-- one case-only target shape. Every previously admitted value stays.
DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
  WHERE conrelid = 'access.governance_case'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%content_report%';
  IF names IS NULL OR array_length(names, 1) <> 1 THEN
    RAISE EXCEPTION 'governance case kind check not found: %', names;
  END IF;
  EXECUTE format('ALTER TABLE access.governance_case DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_kind_check
  CHECK (kind IN ('content_report', 'rights_complaint', 'realm_sanction_appeal'));

DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
  WHERE conrelid = 'access.governance_case'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%target_owner%'
    AND pg_get_constraintdef(oid) LIKE '%review%';
  IF names IS NULL OR array_length(names, 1) <> 1 THEN
    RAISE EXCEPTION 'governance case target owner check not found: %', names;
  END IF;
  EXECUTE format('ALTER TABLE access.governance_case DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_target_owner_check
  CHECK (target_owner IN ('graph', 'content', 'source', 'media', 'review', 'membership'));

DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
  WHERE conrelid = 'access.governance_case'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%target_component%'
    AND pg_get_constraintdef(oid) LIKE '%media_use%';
  IF names IS NULL OR array_length(names, 1) <> 1 THEN
    RAISE EXCEPTION 'governance case target component check not found: %', names;
  END IF;
  EXECUTE format('ALTER TABLE access.governance_case DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_target_component_check
  CHECK (target_component IN ('name', 'title', 'body', 'structure', 'media_use', 'synopsis',
    'cover', 'publication', 'record', 'sanction'));

ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_sanction_appeal_shape
  CHECK ((kind = 'realm_sanction_appeal') = (
    target_owner = 'membership' AND target_component = 'sanction'
    AND target_resource ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

-- Member changes share one receipt action. The column records which change it was
-- so a later unban cannot erase the fact that this receipt banned the member.
ALTER TABLE access.realm_admin_receipt ADD COLUMN member_action text
  CONSTRAINT realm_admin_receipt_member_action_check
  CHECK (member_action IS NULL OR member_action IN ('add', 'remove', 'ban', 'unban'));

CREATE TABLE access.realm_sanction_appeal (
  case_id uuid PRIMARY KEY REFERENCES access.governance_case(id),
  receipt_id uuid NOT NULL REFERENCES access.realm_admin_receipt(id),
  realm text NOT NULL,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  member_subject text NOT NULL REFERENCES access.authority_subject(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000 AND statement = btrim(statement)),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX realm_sanction_appeal_receipt ON access.realm_sanction_appeal (receipt_id, opened_at);
CREATE TRIGGER realm_sanction_appeal_immutable BEFORE UPDATE OR DELETE ON access.realm_sanction_appeal
  FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();

DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
  WHERE conrelid = 'access.moderation_decision'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%organization_publication_rejection%'
    AND pg_get_constraintdef(oid) LIKE '%content_moderation%'
    AND pg_get_constraintdef(oid) LIKE '%rights_disposition%';
  IF names IS NULL OR array_length(names, 1) <> 1 THEN
    RAISE EXCEPTION 'moderation decision kind check not found: %', names;
  END IF;
  EXECUTE format('ALTER TABLE access.moderation_decision DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE access.moderation_decision ADD CONSTRAINT moderation_decision_kind_check
  CHECK (kind IN ('organization_publication_rejection', 'content_moderation', 'rights_disposition',
    'realm_sanction_resolution'));

-- Case decisions still bind a rule and evidence, except a sanction resolution,
-- which has no content rule and must not invent one.
DO $$
DECLARE names text[];
BEGIN
  SELECT array_agg(conname) INTO names FROM pg_constraint
  WHERE conrelid = 'access.moderation_decision'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%evidence_digest IS NOT NULL%'
    AND pg_get_constraintdef(oid) LIKE '%rule_ref IS NOT NULL%';
  IF names IS NULL OR array_length(names, 1) <> 1 THEN
    RAISE EXCEPTION 'moderation decision case basis check not found: %', names;
  END IF;
  EXECUTE format('ALTER TABLE access.moderation_decision DROP CONSTRAINT %I', names[1]);
END $$;
ALTER TABLE access.moderation_decision ADD CONSTRAINT moderation_decision_case_basis
  CHECK (case_id IS NULL OR kind = 'realm_sanction_resolution'
    OR (rule_ref IS NOT NULL AND rule_revision IS NOT NULL
      AND rule_digest IS NOT NULL AND evidence_digest IS NOT NULL));

ALTER TABLE access.moderation_decision ADD CONSTRAINT moderation_decision_sanction_resolution
  CHECK (kind <> 'realm_sanction_resolution' OR (
    outcome IN ('dismiss', 'restore') AND rationale IS NOT NULL AND case_id IS NOT NULL
    AND rule_ref IS NULL AND rule_revision IS NULL AND rule_digest IS NULL AND evidence_digest IS NULL
    AND statement_of_reasons IS NULL AND reverses_decision_id IS NULL));
