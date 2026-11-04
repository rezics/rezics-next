import { expect, test } from 'bun:test';
import { isRecoveryPageStage, observeRecoveryViewer, recoveryPage } from '../src/recovery-page.ts';
const limits = { minPasswordLength: 8, maxPasswordLength: 128 };
const viewer = { kind: 'signed-in' as const, account_id: 'current', email: 'person@example.test' };

test('anonymous advice is uniform and never certifies unsubmitted recovery credentials', () => {
  for (const stage of ['start', 'complete'] as const) {
    const page = recoveryPage(stage, limits, viewer);
    expect(page).toEqual(recoveryPage(stage, limits));
    expect(page.viewer).toEqual({ kind: 'signed-out' });
    expect(page.actions).toEqual({ start: stage === 'start', complete: stage === 'complete', authenticate: false });
    expect(JSON.stringify(page)).not.toContain('current');
  }
  expect(isRecoveryPageStage('person@example.test')).toBe(false);
});

test('step-up exposes only its authorized viewer and installed methods, with review still required', async () => {
  const page = recoveryPage('step-up', limits, await observeRecoveryViewer(async () => viewer));
  expect(page.viewer).toEqual(viewer);
  expect(page.methods).toEqual({ email: true, password: true, passkey: true });
  expect(page.continuation).toBe('authenticate-before-review');
  expect(page.actions).toEqual({ start: false, complete: false, authenticate: true });
  await expect(observeRecoveryViewer(async () => { throw new Error('Unavailable'); })).rejects.toThrow('Unavailable');
});
