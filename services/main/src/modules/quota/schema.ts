import type { OwnerColumns } from '../commerce/owner-columns.ts';

/** Access database `quota` schema, including catalogue intake from migration 973. */
export const quotaSchema = 'quota';

export const quotaColumns = {
  catalogue_search: { id: 'uuid', principal_id: 'uuid', data_epoch: 'text', sequence: 'int8',
    input: 'jsonb', candidates: 'jsonb', expires_at: 'timestamptz' },
  catalogue_creation: { admission_id: 'uuid', principal_id: 'uuid', search_id: 'uuid',
    quota_exempt: 'bool', data_epoch: 'text' },
  catalogue_pending: { principal_id: 'uuid', slot: 'int2', admission_id: 'uuid' },
  policy: { id: 'uuid', scope: 'text', unit: 'text', head_revision: 'int8' },
  policy_revision: { policy_id: 'uuid', revision: 'int8', period: 'text', base_allowance: 'int8',
    max_reservation: 'int8', reservation_ttl: 'interval', failure_policy: 'text',
    created_at: 'timestamptz' },
  ledger: { id: 'uuid', policy_id: 'uuid', policy_revision: 'int8', beneficiary: 'text',
    source: 'text', entitlement_id: 'uuid?', period_start: 'timestamptz',
    period_end: 'timestamptz?', capacity: 'int8', reserved: 'int8', consumed: 'int8',
    open: 'bool', created_at: 'timestamptz' },
  reservation: { id: 'uuid', ledger_id: 'uuid', policy_id: 'uuid', policy_revision: 'int8',
    operation_id: 'text', stage: 'int4', request_digest: 'text', admission_id: 'uuid?',
    amount: 'int8', consumed: 'int8', state: 'text', generation: 'int8',
    expires_at: 'timestamptz', created_at: 'timestamptz' },
  reservation_event: { reservation_id: 'uuid', generation: 'int8', action: 'text', state: 'text',
    consumed: 'int8', expires_at: 'timestamptz', ack_reference: 'text?',
    created_at: 'timestamptz' },
} as const satisfies OwnerColumns;
