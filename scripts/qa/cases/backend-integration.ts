import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/backend-integration.md', [
  {
    id: 'SYS01',
    scenario: 'Agent provisioning succeeds only in one owner',
    requiredResult: 'Pending explicit state; retry/compensate without authority leak.',
  },
  {
    id: 'SYS02',
    scenario: 'Jena commit succeeds but response is lost',
    requiredResult: 'Receipt lookup/retry returns same effective result.',
  },
  {
    id: 'SYS03',
    scenario: 'Unrelated transaction advances the dataset sequence',
    requiredResult: 'Cannot falsely report own failed CAS as successful.',
  },
  {
    id: 'SYS04',
    scenario: 'Outbox publishes and consumer crashes before ACK',
    requiredResult: 'Duplicate delivery produces one durable effect.',
  },
  {
    id: 'SYS05',
    scenario: 'Broker retention expires before consumer checkpoint',
    requiredResult: 'Gap detected and reconciled/rebuilt.',
  },
  {
    id: 'SYS06',
    scenario: 'Revoke principal during import/export/install',
    requiredResult: 'Current fences constrain activation/delivery.',
  },
  {
    id: 'SYS07',
    scenario: 'Erase then restore older stores and replay events',
    requiredResult: 'Erasure frontier prevents resurrection.',
  },
  {
    id: 'SYS08',
    scenario: 'Move owner partition with old workers',
    requiredResult: 'Routing and lease epochs reject old writes.',
  },
  {
    id: 'SYS09',
    scenario: 'Object upload succeeds but graph activation fails',
    requiredResult: 'Safe staged orphan cleanup; no broken published reference.',
  },
  {
    id: 'SYS10',
    scenario: 'Conditional Fuseki Update returns 200/204 with no matching guard',
    requiredResult:
      'Own receipt determines outcome; unrelated sequence progress cannot produce success.',
  },
  {
    id: 'SYS11',
    scenario: 'Delayed update races terminal cancellation/rejection',
    requiredResult:
      'Same receipt identity admits one winner; strong revocation waits for durable sealing/reconciliation.',
  },
  {
    id: 'SYS12',
    scenario: 'Outbox contains zero-event batches or retention gaps',
    requiredResult:
      'Batch counts and contiguous epoch/sequence prove coverage; missing retained work requires recovery.',
  },
  {
    id: 'SYS13',
    scenario: 'Restore loses a later receipt while a client retries its old command',
    requiredResult:
      'New data epoch rejects unproved old intent; external effects reconcile before replay.',
  },
  {
    id: 'SYS14',
    scenario: 'Two requests use the same idempotency key with different digests',
    requiredResult:
      'One recorded outcome; the conflicting digest never rewrites or replays another request.',
  },
]);
