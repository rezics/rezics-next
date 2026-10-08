-- A reversed sanction appeal records when the ban ended and which receipt
-- lifted it. Dismissal does not write a row. The receipt is null only when
-- the ban had already expired and nobody wrote an unban.
CREATE TABLE access.realm_sanction_lift (
  decision_id uuid PRIMARY KEY REFERENCES access.moderation_decision(id),
  receipt_id uuid REFERENCES access.realm_admin_receipt(id),
  lifted_at timestamptz NOT NULL
);
CREATE TRIGGER realm_sanction_lift_immutable BEFORE UPDATE OR DELETE ON access.realm_sanction_lift
  FOR EACH ROW EXECUTE FUNCTION access.reject_governance_mutation();
