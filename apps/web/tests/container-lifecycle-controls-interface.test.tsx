import { expect, test } from 'bun:test';
import { lifecycleControlsPresentation, type LifecycleState } from '../src/community/container-lifecycle';

const target = { kind: 'space', id: 'space-one' } as const;
const unresolvedRemoval = {
  read: { kind: 'ready', snapshot: { target, head: 'head-one', contextId: null, state: 'removed', actions: [] } },
  reason: 'Repeated disruption',
  intent: {
    target,
    action: 'remove',
    expectedHead: 'head-one',
    idempotencyKey: 'operation-one',
    reason: 'Repeated disruption',
    contextId: null,
  },
  outcome: 'uncertain',
  problem: null,
  destination: null,
  busy: false,
  reviewed: true,
} satisfies LifecycleState;

test('an uncertain lifecycle operation stays available when the latest read offers no action', () => {
  expect(lifecycleControlsPresentation(unresolvedRemoval)).toEqual({ visible: true, readOnly: false, canRetry: true });
});
