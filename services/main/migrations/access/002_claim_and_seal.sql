-- Shared dispatch fence for all Main replicas. A strong close stops claims
-- before graph receipt cancellation/reconciliation begins.
ALTER TABLE access.scope_gate
    ADD COLUMN dispatch_open boolean NOT NULL DEFAULT true,
    ADD CONSTRAINT scope_gate_dispatch_implies_closed CHECK (dispatch_open OR NOT open);

ALTER TABLE access.admission DROP CONSTRAINT admission_state_check;
ALTER TABLE access.admission
    ADD CONSTRAINT admission_state_check CHECK (state IN ('registered', 'claimed', 'sealed')),
    ADD COLUMN claimed_at timestamptz,
    ADD COLUMN graph_receipt text,
    ADD COLUMN graph_outcome text CHECK (graph_outcome IN ('succeeded', 'cancelled')),
    ADD COLUMN graph_data_epoch text,
    ADD COLUMN graph_sequence text CHECK (graph_sequence ~ '^[0-9]+$'),
    ADD COLUMN sealed_at timestamptz,
    ADD CONSTRAINT admission_claim_complete CHECK (state <> 'claimed' OR claimed_at IS NOT NULL),
    ADD CONSTRAINT admission_seal_complete CHECK (
        (state = 'sealed') =
        (graph_receipt IS NOT NULL AND graph_outcome IS NOT NULL AND
         graph_data_epoch IS NOT NULL AND graph_sequence IS NOT NULL AND sealed_at IS NOT NULL)
    );
CREATE INDEX admission_unsealed_scope ON access.admission (scope_id, id)
    WHERE state <> 'sealed';

ALTER TABLE access.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE access.outbox ADD CONSTRAINT outbox_kind_check CHECK
    (kind IN ('admission.registered', 'admission.claimed', 'admission.sealed',
              'scope.closed', 'scope.strong_closed'));
