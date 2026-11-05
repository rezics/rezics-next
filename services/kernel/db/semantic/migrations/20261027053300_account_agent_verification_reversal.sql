-- migrate:up
ALTER TABLE semantic.account_agent_moved_link
  ADD COLUMN property text,
  ADD COLUMN source_subject_id uuid,
  ADD COLUMN filter_value uuid,
  ADD COLUMN context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid,
  ADD COLUMN source_revision integer,
  ADD COLUMN source_security_revision bigint,
  ADD COLUMN present boolean,
  ADD COLUMN source_type text,
  ADD COLUMN order_key text,
  ADD COLUMN reversal_prepared boolean NOT NULL DEFAULT false,
  ADD COLUMN reversed boolean NOT NULL DEFAULT false;

UPDATE semantic.account_agent_moved_link AS moved
SET property = link.property,
    source_subject_id = link.source_subject_id,
    filter_value = link.filter_value,
    context_id = link.context_id
FROM semantic.inbound_link AS link
WHERE link.route = moved.route AND link.subject_id = moved.survivor
  AND link.statement_id = moved.statement_id;

DELETE FROM semantic.account_agent_moved_link AS moved
WHERE moved.property IS NULL OR moved.source_subject_id IS NULL
   OR moved.filter_value IS NULL OR moved.context_id IS NULL;

ALTER TABLE semantic.account_agent_moved_link
  ALTER COLUMN property SET NOT NULL,
  ALTER COLUMN source_subject_id SET NOT NULL,
  ALTER COLUMN filter_value SET NOT NULL,
  ALTER COLUMN context_id SET NOT NULL;

ALTER TABLE semantic.account_agent_moved_link
  DROP CONSTRAINT account_agent_moved_link_pkey,
  ADD CONSTRAINT account_agent_moved_link_pkey
    PRIMARY KEY (route, receipt_id, moved_from, property, source_subject_id, statement_id, filter_value, context_id);

INSERT INTO semantic.account_agent_moved_link (
  route, receipt_id, account_id, survivor, moved_from, statement_id,
  property, source_subject_id, filter_value, context_id
)
SELECT moved.route, moved.receipt_id, moved.account_id, moved.survivor, moved.moved_from,
       moved.statement_id, link.property, link.source_subject_id, link.filter_value, link.context_id
FROM semantic.account_agent_moved_link AS moved
JOIN semantic.inbound_link AS link
  ON link.route = moved.route AND link.subject_id = moved.survivor
 AND link.statement_id = moved.statement_id
ON CONFLICT (route, receipt_id, moved_from, property, source_subject_id, statement_id, filter_value, context_id) DO NOTHING;

ALTER TABLE semantic.revision
  ADD COLUMN revocation_receipt_id text,
  ADD COLUMN revoked_survivor_id uuid,
  ADD CONSTRAINT revision_revocation_receipt_check
    CHECK (revocation_receipt_id IS NULL OR length(revocation_receipt_id) BETWEEN 1 AND 255);

CREATE FUNCTION semantic.prevent_redirect_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
      FROM semantic.revision AS revision
      WHERE revision.route = OLD.route AND revision.subject_id = OLD.subject_id
        AND revision.revision = (
          SELECT max(latest.revision)
          FROM semantic.revision AS latest
          WHERE latest.route = OLD.route AND latest.subject_id = OLD.subject_id
        )
        AND revision.revocation_receipt_id IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Semantic redirects are immutable' USING ERRCODE = '23514';
  END;
  $$;

DROP TRIGGER redirect_immutable ON semantic.redirect;
CREATE TRIGGER redirect_immutable BEFORE DELETE OR UPDATE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_redirect_mutation();

-- migrate:down
DROP TRIGGER redirect_immutable ON semantic.redirect;
DROP FUNCTION semantic.prevent_redirect_mutation();
CREATE TRIGGER redirect_immutable BEFORE DELETE OR UPDATE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

ALTER TABLE semantic.revision
  DROP CONSTRAINT revision_revocation_receipt_check,
  DROP COLUMN revocation_receipt_id,
  DROP COLUMN revoked_survivor_id;

ALTER TABLE semantic.account_agent_moved_link
  DROP CONSTRAINT account_agent_moved_link_pkey;

DELETE FROM semantic.account_agent_moved_link AS moved
USING (
  SELECT ctid, row_number() OVER (
    PARTITION BY route, receipt_id, moved_from, statement_id ORDER BY property, source_subject_id, filter_value, context_id
  ) AS duplicate_number
  FROM semantic.account_agent_moved_link
) AS duplicates
WHERE moved.ctid = duplicates.ctid AND duplicates.duplicate_number > 1;

ALTER TABLE semantic.account_agent_moved_link
  ADD CONSTRAINT account_agent_moved_link_pkey PRIMARY KEY (route, receipt_id, moved_from, statement_id);

ALTER TABLE semantic.account_agent_moved_link
  DROP COLUMN property,
  DROP COLUMN source_subject_id,
  DROP COLUMN filter_value,
  DROP COLUMN context_id,
  DROP COLUMN source_revision,
  DROP COLUMN source_security_revision,
  DROP COLUMN present,
  DROP COLUMN source_type,
  DROP COLUMN order_key,
  DROP COLUMN reversal_prepared,
  DROP COLUMN reversed;
