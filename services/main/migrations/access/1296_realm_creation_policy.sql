-- Historical initializations have no delivered initial policy. Keep their
-- immutable records intact; new completions bind the policy receipt explicitly.
ALTER TABLE access.realm_creation_initialization
  ADD COLUMN policy_receipt uuid REFERENCES access.realm_admin_receipt(id);
