import { expect, test } from 'bun:test';
import {
  SOURCE_ASSOCIATION_CALLBACK_MAX,
  SOURCE_ASSOCIATION_COMMAND_DISPATCH_ALLOWANCE,
  SOURCE_ASSOCIATION_COMMAND_DISPATCH_CONTROLS,
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
} from '../../src/command/dispatch-lifetime.ts';

test('event-callback-source-association is the fence profile plus two Source callbacks', () => {
  const fence = SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE;
  const association = SOURCE_ASSOCIATION_COMMAND_DISPATCH_ALLOWANCE();
  const controls = SOURCE_ASSOCIATION_COMMAND_DISPATCH_CONTROLS();
  const extra = controls.callbackAdmission.work.bytes + controls.sourceAssociation.work.bytes;
  expect(association.profile).toBe('event-callback-source-association');
  expect(association.maxima.callbacks).toBe(SOURCE_ASSOCIATION_CALLBACK_MAX);
  expect(SOURCE_ASSOCIATION_CALLBACK_MAX).toBe(2);
  expect(association.maxima.events).toBe(1);
  expect(association.total.engineRequests).toBe(0);
  expect(association.total.work.nativeRows).toBe(fence.total.work.nativeRows);
  expect(association.total.work.nativePoints).toBe(fence.total.work.nativePoints);
  expect(association.total.work.statements).toBe(fence.total.work.statements);
  expect(association.total.work.bytes).toBe(fence.total.work.bytes + extra);
  expect(association.total.work.emptySeeks).toBe(fence.total.work.emptySeeks);
  expect(association.effect.work.bytes).toBe(fence.effect.work.bytes + extra);
  expect(association.cleanup).toEqual(controls.cleanupRollback);
});

test('original-funded disposition composes Access, participant, binding, hold and association from installed owners', async () => {
  const { readIdentitySourceOriginalCostDisposition } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const disposition = await readIdentitySourceOriginalCostDisposition();
  expect(disposition.widerExecutor.profile).toBe('event-callback-source-association');
  expect(disposition.missing.some((term) => term.includes('History'))).toBeFalse();
  expect(
    disposition.missing.some((term) => term.includes('event-callback') || term.includes('wider executor')),
  ).toBeFalse();
  expect(disposition.accessOriginal?.engineRequests).toBe(0);
  expect(disposition.jobRead?.engineRequests).toBe(0);
  expect(disposition.stepReconcile?.engineRequests).toBe(0);
  expect(disposition.bindingConsumer?.engineRequests).toBe(0);
  expect(disposition.local.association.engineRequests).toBe(0);
  if (
    disposition.accessOriginal &&
    disposition.jobRead &&
    disposition.stepReconcile &&
    disposition.bindingConsumer &&
    disposition.nativeHold &&
    disposition.libraryDeclaration
  )
    expect(disposition.state).toBe('complete');
  else expect(disposition.state).toBe('missing');
});
