-- migrate:up
CREATE FUNCTION semantic.prevent_fact_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only the derived account node's display label is erasable personal data.
  IF TG_OP = 'DELETE' AND OLD.kind = 'label' AND EXISTS (
    SELECT 1 FROM semantic.account_agent_subject account
    WHERE account.agent_id = OLD.subject_id AND account.account_route = OLD.route
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER fact_immutable ON semantic.fact;
CREATE TRIGGER fact_immutable BEFORE UPDATE OR DELETE ON semantic.fact
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_fact_mutation();

-- Remove pre-existing label history, including the values in retraction rows.
WITH labels AS MATERIALIZED (
  SELECT fact.route, fact.subject_id, fact.slot_id, fact.log_seq, fact.operation,
         row_number() OVER (
           PARTITION BY fact.route, fact.subject_id, fact.language ORDER BY fact.log_seq DESC
         ) AS ordinal
  FROM semantic.fact fact
  JOIN semantic.account_agent_subject account
    ON account.account_route = fact.route AND account.agent_id = fact.subject_id
  WHERE fact.kind = 'label'
), removed AS (
  DELETE FROM semantic.fact fact USING labels
  WHERE fact.route = labels.route AND fact.subject_id = labels.subject_id
    AND fact.slot_id = labels.slot_id AND fact.log_seq = labels.log_seq
    AND (labels.ordinal > 1 OR labels.operation <> 'assert')
  RETURNING fact.route, fact.subject_id
), counts AS (
  SELECT route, subject_id, count(*) AS removed FROM removed GROUP BY route, subject_id
)
UPDATE semantic.subject subject
SET current_facts = subject.current_facts - counts.removed
FROM counts WHERE subject.route = counts.route AND subject.subject_id = counts.subject_id;

-- migrate:down
DROP TRIGGER fact_immutable ON semantic.fact;
CREATE TRIGGER fact_immutable BEFORE UPDATE OR DELETE ON semantic.fact
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
DROP FUNCTION semantic.prevent_fact_mutation();
