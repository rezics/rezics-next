import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  assertOperationOutcome,
  assertOperationTransition,
  operationOutcome,
  type OperationItem,
} from '../src/modules/operation/outcome.ts';
import { operationResult } from '../src/modules/operation/contract.ts';
import { enforcementEffects } from '../src/modules/governance/schema.ts';
import { restrictionOwners } from '../src/modules/governance/effects.ts';
import { openApiOperations } from '../src/routes/safety-cases.ts';

const item = (
  ordinal: number,
  state: OperationItem['state'],
  receipt: string | null = null,
): OperationItem => ({
  ordinal,
  target: `target-${ordinal}`,
  state,
  receipt,
  continuation: null,
  error: null,
});

test('G-565: every restriction kind has an owner effect', () => {
  expect(Object.keys(restrictionOwners).sort()).toEqual([...enforcementEffects].sort());
  for (const effect of enforcementEffects) expect(restrictionOwners[effect]).toBeTruthy();
});

test('G-565: operation conformance preserves partial receipts and forbids completion without every confirmation', () => {
  const accepted = operationOutcome('decision', [item(1, 'pending'), item(2, 'pending')]);
  expect(accepted.status).toBe('accepted');
  const partial = operationOutcome('decision', [
    item(1, 'confirmed', 'owner:one'),
    item(2, 'uncertain'),
  ]);
  expect(partial.status).toBe('partial');
  expect(() => assertOperationTransition(accepted, partial)).not.toThrow();
  expect(() =>
    assertOperationOutcome({ ...partial, status: 'completed', continuation: null }),
  ).toThrow();
  expect(() => operationOutcome('decision', [item(1, 'confirmed')])).toThrow();
  const completed = operationOutcome('decision', [
    item(1, 'confirmed', 'owner:one'),
    item(2, 'confirmed', 'owner:two'),
  ]);
  expect(completed.status).toBe('completed');
  expect(Value.Check(operationResult, completed)).toBe(true);
  expect(() => assertOperationTransition(partial, completed)).not.toThrow();
  expect(() =>
    assertOperationTransition(completed, { ...completed, status: 'cancelled' }),
  ).toThrow();
});

test('G-565: cancellation stops future effects and cannot be presented as undo', () => {
  const partial = operationOutcome('decision', [
    item(1, 'confirmed', 'owner:one'),
    item(2, 'pending'),
  ]);
  const cancelled = operationOutcome('decision', partial.items, true);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.continuation).toBeNull();
  expect(() => assertOperationTransition(partial, cancelled)).not.toThrow();
  expect(() =>
    assertOperationTransition(
      partial,
      operationOutcome('decision', [item(1, 'pending'), item(2, 'pending')], true),
    ),
  ).toThrow();
  expect(() => assertOperationTransition(cancelled, partial)).toThrow();
});

test('G-565: staff operations declare bearer and command idempotency while notices remain a private read', () => {
  for (const methods of Object.values(openApiOperations))
    for (const [method, operation] of Object.entries(methods)) {
      expect(operation.bearer).toBe(true);
      if (method === 'post') expect(operation).toHaveProperty('idempotencyKey', true);
    }
});
