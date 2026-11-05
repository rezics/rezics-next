import { expect, test } from 'bun:test';
import {
  OPERATOR_TRANSFER_PAGE_MAX_RESPONSE_BYTES as success,
  OPERATOR_TRANSFER_PAGE_MAX_ERROR_BYTES as error,
} from '@rezics/auth-contract';

test('all closed stages, viewer continuations and action flags fit the public independent allowances', () => {
  const reviews = [
    ...['readiness', 'missing', 'refused', 'changed', 'unavailable'].map((kind) => ({ kind })),
    ...['allowed', 'denied'].map((action) => ({ kind: 'destination', destinationAccountId: 'f'.repeat(36), action })),
  ];
  for (const viewer of [
    { kind: 'ready' },
    { kind: 'signed-out' },
    { kind: 'refused' },
    { kind: 'authentication-required', continuation: 'operator-transfer' },
  ])
    for (const review of reviews) {
      expect(Buffer.byteLength(JSON.stringify({ viewer, review }))).toBeLessThanOrEqual(success);
    }
  const bodies = [
    { viewer: { kind: 'refused' }, review: { kind: 'refused' } },
    { viewer: { kind: 'ready' }, review: { kind: 'unavailable' } },
  ];
  expect(Math.max(...bodies.map((body) => Buffer.byteLength(JSON.stringify(body))))).toBe(error);
});
