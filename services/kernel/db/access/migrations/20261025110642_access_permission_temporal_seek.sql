-- migrate:up
-- One actor-state read is reused by authorization. Admission coverage is a
-- projection of the same canonical flag, not a second membership registry.
CREATE VIEW access.membership_inverse_coverage AS
  SELECT route, account_id, membership_inverse_complete AS complete FROM access.account;

-- Negative role proofs end at the next transition without expanding history.
CREATE INDEX organization_member_next_role ON access.organization_member
  (route, organization_id, member_account_id, role, lower(valid)) WHERE NOT lower_inf(valid);

-- Denial reasons are bounded, but need not participate in candidate identity.
-- Keep the native valid-range operand in the exact selective probe index.
CREATE INDEX resource_denial_permission ON access.resource_denial USING gist
  (route, resource_id, action, subject_id, subject_role, valid);

-- migrate:down
-- Forward only: the evaluator relies on native temporal seeks.
