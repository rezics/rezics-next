-- A durable Account deletion intent follows the principal authority fence.
-- Retain it even if the later Account user deletion fails; restoration must
-- reconcile that pending cross-owner operation before routing.
ALTER TABLE access.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_kind_check CHECK
    (kind IN ('admission.registered', 'admission.claimed', 'admission.sealed',
              'scope.closed', 'scope.strong_closed', 'principal.deactivated',
              'account.deletion_fenced'));
ALTER TABLE access.outbox DROP CONSTRAINT outbox_target_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_target_check CHECK
    ((kind IN ('principal.deactivated', 'account.deletion_fenced')
      AND principal_id IS NOT NULL AND scope_id IS NULL AND admission_id IS NULL)
     OR (kind NOT IN ('principal.deactivated', 'account.deletion_fenced')
      AND principal_id IS NULL AND scope_id IS NOT NULL));
CREATE UNIQUE INDEX access_outbox_account_deletion_fence
    ON access.outbox (principal_id) WHERE kind = 'account.deletion_fenced';
