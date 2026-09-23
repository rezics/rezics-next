-- Principal deactivation is a durable authority fence with a private outbox fact.
ALTER TABLE access.outbox
    ALTER COLUMN scope_id DROP NOT NULL,
    ADD COLUMN principal_id uuid REFERENCES access.principal(id);
ALTER TABLE access.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_kind_check CHECK
    (kind IN ('admission.registered', 'admission.claimed', 'admission.sealed',
              'scope.closed', 'scope.strong_closed', 'principal.deactivated'));
ALTER TABLE access.outbox ADD CONSTRAINT outbox_target_check CHECK
    ((kind = 'principal.deactivated' AND principal_id IS NOT NULL
      AND scope_id IS NULL AND admission_id IS NULL)
     OR (kind <> 'principal.deactivated' AND principal_id IS NULL AND scope_id IS NOT NULL));
CREATE INDEX access_outbox_principal_fk ON access.outbox (principal_id)
    WHERE principal_id IS NOT NULL;
