-- migrate:up
-- Independent discovery checkpoints belong to the permanent committed obligation.
CREATE TABLE access.erasure_progress (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  store text NOT NULL,
  role text NOT NULL,
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  cursor text[],
  state text NOT NULL DEFAULT 'discovering' CHECK (state IN ('discovering', 'discovered')),
  last_page integer NOT NULL DEFAULT -1 CHECK (last_page >= -1),
  result jsonb CHECK (octet_length(result::text) <= 65536),
  PRIMARY KEY (route, account_id, store, role),
  FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id)
);

-- Permission and installation keys contain unbounded vocabulary. Use compact native locators.
ALTER TABLE access.resource_denial ADD COLUMN erasure_key bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE access.resource_grant ADD COLUMN erasure_key bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE access.resource_role_grant ADD COLUMN erasure_key bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE access.standing_parent_installation ADD COLUMN erasure_key bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

CREATE INDEX erasure_account_account_id ON access.account (account_id, route);
CREATE INDEX erasure_account_operator_account_id ON access.account (operator_account_id, route, account_id);
CREATE INDEX erasure_account_controller_id ON access.account (controller_id, route, account_id);
CREATE INDEX erasure_account_preferences_account_id ON access.account_preferences (account_id, route);
CREATE INDEX erasure_agent_page_account_id ON access.agent_page (account_id, route, subject_id);
CREATE INDEX erasure_agent_verification_request_account_id ON access.agent_verification_request (account_id, route, request_id);
CREATE INDEX erasure_agent_verification_request_requested_by ON access.agent_verification_request (requested_by, route, request_id);
CREATE INDEX erasure_agent_verification_request_decided_by ON access.agent_verification_request (decided_by, route, request_id);
CREATE INDEX erasure_committed_continuation_account_id ON access.committed_continuation (account_id, route, continuation_id);
CREATE INDEX erasure_committed_continuation_prior_operator_account_id ON access.committed_continuation (prior_operator_account_id, route, continuation_id);
CREATE INDEX erasure_credential_floor_receipt_account_id ON access.credential_floor_receipt (account_id, route, opening_receipt_id);
CREATE INDEX erasure_erasure_account_id ON access.erasure (account_id, route);
CREATE INDEX erasure_erasure_acknowledgement_account_id ON access.erasure_acknowledgement (account_id, route, participant);
CREATE INDEX erasure_governance_bootstrap_account_id ON access.governance_bootstrap (account_id, route, resource_id);
CREATE INDEX erasure_governance_reach_actor_account_id ON access.governance_reach (actor_account_id, route, transaction_id, action, resource_id);
CREATE INDEX erasure_governance_reach_resource_id ON access.governance_reach (resource_id, route, transaction_id, action);
CREATE INDEX erasure_handle_claim_account_id ON access.handle_claim (account_id, route, normalized_handle);
CREATE INDEX erasure_lifecycle_coordination_account_id ON access.lifecycle_coordination (account_id, route, reservation_id);
CREATE INDEX erasure_lifecycle_coordination_related_account_id ON access.lifecycle_coordination (related_account_id, route, account_id, reservation_id);
CREATE INDEX erasure_lifecycle_fence_receipt_account_id ON access.lifecycle_fence_receipt (account_id, route, receipt_id);
CREATE INDEX erasure_lifecycle_fence_receipt_prior_operator_account_id ON access.lifecycle_fence_receipt (prior_operator_account_id, route, account_id, receipt_id);
CREATE INDEX erasure_lifecycle_fence_receipt_operator_account_id ON access.lifecycle_fence_receipt (operator_account_id, route, account_id, receipt_id);
CREATE INDEX erasure_lifecycle_handle_effect_account_id ON access.lifecycle_handle_effect (account_id, route, normalized_handle, reservation_id, operation_id, effect);
CREATE INDEX erasure_lifecycle_handle_operation_account_id ON access.lifecycle_handle_operation (account_id, route, operation_id);
CREATE INDEX erasure_lifecycle_membership_slot_organization_id ON access.lifecycle_membership_slot (organization_id, route, member_account_id, reservation_id);
CREATE INDEX erasure_lifecycle_membership_slot_member_account_id ON access.lifecycle_membership_slot (member_account_id, route, organization_id, reservation_id);
CREATE INDEX erasure_lifecycle_registration_expiry_account_id ON access.lifecycle_registration_expiry (account_id, route, reservation_id);
CREATE INDEX erasure_membership_inverse_account_id ON access.membership_inverse (account_id, route, kind, group_id);
CREATE INDEX erasure_membership_inverse_group_id ON access.membership_inverse (group_id, route, account_id, kind);
CREATE INDEX erasure_membership_inverse_terminal_account_id ON access.membership_inverse_terminal (account_id, route, kind, group_id, reservation_id);
CREATE INDEX erasure_membership_inverse_terminal_group_id ON access.membership_inverse_terminal (group_id, route, account_id, kind, reservation_id);
CREATE INDEX erasure_operator_opening_receipt_operator_account_id ON access.operator_opening_receipt (operator_account_id, route, receipt_id);
CREATE INDEX erasure_operator_opening_receipt_subject_account_id ON access.operator_opening_receipt (subject_account_id, route, operator_account_id, receipt_id);
CREATE INDEX erasure_operator_opening_receipt_acting_human_id ON access.operator_opening_receipt (acting_human_id, route, operator_account_id, receipt_id);
CREATE INDEX erasure_operator_relation_slot_subject_account_id ON access.operator_relation_slot (subject_account_id, route, reservation_id);
CREATE INDEX erasure_operator_relation_slot_operator_account_id ON access.operator_relation_slot (operator_account_id, route, subject_account_id, reservation_id);
CREATE INDEX erasure_organization_close_organization_id ON access.organization_close (organization_id, route);
CREATE INDEX erasure_organization_close_cursor_member ON access.organization_close (cursor_member, route, organization_id);
CREATE INDEX erasure_organization_member_organization_id ON access.organization_member (organization_id, route, member_account_id, valid);
CREATE INDEX erasure_organization_member_member_account_id ON access.organization_member (member_account_id, route, organization_id, valid);
CREATE INDEX erasure_principal_assignment_principal_id ON access.principal_assignment (principal_id, route, request_id);
CREATE INDEX erasure_principal_assignment_creator_principal_id ON access.principal_assignment (creator_principal_id, route, principal_id, request_id);
CREATE INDEX erasure_principal_assignment_assigned_actor_id ON access.principal_assignment (assigned_actor_id, route, principal_id, request_id);
CREATE INDEX erasure_rating_counter_controller_account_id ON access.rating_counter_controller (account_id, route, effective_at);
CREATE INDEX erasure_rating_counter_controller_controller_id ON access.rating_counter_controller (controller_id, route, account_id, effective_at);
CREATE INDEX erasure_resource_denial_resource_id ON access.resource_denial (resource_id, route, erasure_key);
CREATE INDEX erasure_resource_denial_subject_id ON access.resource_denial (subject_id, route, erasure_key);
CREATE INDEX erasure_resource_grant_resource_id ON access.resource_grant (resource_id, route, erasure_key);
CREATE INDEX erasure_resource_grant_subject_id ON access.resource_grant (subject_id, route, erasure_key) WHERE subject_kind = 'identity';
CREATE INDEX erasure_resource_initialization_resource_id ON access.resource_initialization (resource_id, route);
CREATE INDEX erasure_resource_initialization_creator_id ON access.resource_initialization (creator_id, route, resource_id);
CREATE INDEX erasure_resource_role_grant_resource_id ON access.resource_role_grant (resource_id, route, erasure_key);
CREATE INDEX erasure_resource_role_grant_subject_id ON access.resource_role_grant (subject_id, route, erasure_key) WHERE subject_kind = 'identity';
CREATE INDEX erasure_standing_parent_installation_resource_id ON access.standing_parent_installation (resource_id, route, erasure_key);
CREATE INDEX erasure_workflow_approval_actor_id ON access.workflow_approval (actor_id, route, approval_id);

-- migrate:down
DROP INDEX access.erasure_workflow_approval_actor_id;
DROP INDEX access.erasure_standing_parent_installation_resource_id;
DROP INDEX access.erasure_resource_role_grant_subject_id;
DROP INDEX access.erasure_resource_role_grant_resource_id;
DROP INDEX access.erasure_resource_initialization_creator_id;
DROP INDEX access.erasure_resource_initialization_resource_id;
DROP INDEX access.erasure_resource_grant_subject_id;
DROP INDEX access.erasure_resource_grant_resource_id;
DROP INDEX access.erasure_resource_denial_subject_id;
DROP INDEX access.erasure_resource_denial_resource_id;
DROP INDEX access.erasure_rating_counter_controller_controller_id;
DROP INDEX access.erasure_rating_counter_controller_account_id;
DROP INDEX access.erasure_principal_assignment_assigned_actor_id;
DROP INDEX access.erasure_principal_assignment_creator_principal_id;
DROP INDEX access.erasure_principal_assignment_principal_id;
DROP INDEX access.erasure_organization_member_member_account_id;
DROP INDEX access.erasure_organization_member_organization_id;
DROP INDEX access.erasure_organization_close_cursor_member;
DROP INDEX access.erasure_organization_close_organization_id;
DROP INDEX access.erasure_operator_relation_slot_operator_account_id;
DROP INDEX access.erasure_operator_relation_slot_subject_account_id;
DROP INDEX access.erasure_operator_opening_receipt_acting_human_id;
DROP INDEX access.erasure_operator_opening_receipt_subject_account_id;
DROP INDEX access.erasure_operator_opening_receipt_operator_account_id;
DROP INDEX access.erasure_membership_inverse_terminal_group_id;
DROP INDEX access.erasure_membership_inverse_terminal_account_id;
DROP INDEX access.erasure_membership_inverse_group_id;
DROP INDEX access.erasure_membership_inverse_account_id;
DROP INDEX access.erasure_lifecycle_registration_expiry_account_id;
DROP INDEX access.erasure_lifecycle_membership_slot_member_account_id;
DROP INDEX access.erasure_lifecycle_membership_slot_organization_id;
DROP INDEX access.erasure_lifecycle_handle_operation_account_id;
DROP INDEX access.erasure_lifecycle_handle_effect_account_id;
DROP INDEX access.erasure_lifecycle_fence_receipt_operator_account_id;
DROP INDEX access.erasure_lifecycle_fence_receipt_prior_operator_account_id;
DROP INDEX access.erasure_lifecycle_fence_receipt_account_id;
DROP INDEX access.erasure_lifecycle_coordination_related_account_id;
DROP INDEX access.erasure_lifecycle_coordination_account_id;
DROP INDEX access.erasure_handle_claim_account_id;
DROP INDEX access.erasure_governance_reach_resource_id;
DROP INDEX access.erasure_governance_reach_actor_account_id;
DROP INDEX access.erasure_governance_bootstrap_account_id;
DROP INDEX access.erasure_erasure_acknowledgement_account_id;
DROP INDEX access.erasure_erasure_account_id;
DROP INDEX access.erasure_credential_floor_receipt_account_id;
DROP INDEX access.erasure_committed_continuation_prior_operator_account_id;
DROP INDEX access.erasure_committed_continuation_account_id;
DROP INDEX access.erasure_agent_verification_request_decided_by;
DROP INDEX access.erasure_agent_verification_request_requested_by;
DROP INDEX access.erasure_agent_verification_request_account_id;
DROP INDEX access.erasure_agent_page_account_id;
DROP INDEX access.erasure_account_preferences_account_id;
DROP INDEX access.erasure_account_controller_id;
DROP INDEX access.erasure_account_operator_account_id;
DROP INDEX access.erasure_account_account_id;
ALTER TABLE access.resource_denial DROP COLUMN erasure_key;
ALTER TABLE access.resource_grant DROP COLUMN erasure_key;
ALTER TABLE access.resource_role_grant DROP COLUMN erasure_key;
ALTER TABLE access.standing_parent_installation DROP COLUMN erasure_key;
DROP TABLE access.erasure_progress;
