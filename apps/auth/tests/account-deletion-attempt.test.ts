import { expect, test } from 'bun:test';
import {
  beginAccountDeletionAttempt,
  createAccountDeletionAttempt,
  finishAccountDeletionAttempt,
  markAccountDeletionExecutionDispatched,
  restoreAccountDeletionAttempt,
  retireAccountDeletionAttempt,
} from '../src/account-deletion-attempt';

const operation = { kind: 'delete' as const, accountId: 'account-a' };
const key = 'a'.repeat(32);

test('a first approval refusal stays a definitive unsent review', () => {
  const first = beginAccountDeletionAttempt(createAccountDeletionAttempt(operation.accountId, key), 4);
  const refused = finishAccountDeletionAttempt(first, first.runId, { ok: false, reason: 'denied' });
  expect(refused).toMatchObject({ operation, operationKey: key, phase: 'review', submitted: false, uncertain: false });
});

test.each(['denied', 'step-up', 'unavailable', 'platform-closed', 'failure'] as const)(
  'a later %s response cannot resolve an earlier unknown execution',
  (reason) => {
    const first = beginAccountDeletionAttempt(createAccountDeletionAttempt(operation.accountId, key), 1);
    const dispatched = markAccountDeletionExecutionDispatched(first, first.runId);
    const unknown = finishAccountDeletionAttempt(dispatched, first.runId, { ok: false, reason: 'unknown' });
    const retry = beginAccountDeletionAttempt(unknown, 2);
    const later = finishAccountDeletionAttempt(retry, retry.runId, { ok: false, reason });
    expect(later).toMatchObject({ operation, operationKey: key, phase: 'unknown', submitted: true, uncertain: true });
  },
);

test('only a validated completion for the retained account settles uncertainty', () => {
  const first = beginAccountDeletionAttempt(createAccountDeletionAttempt(operation.accountId, key), 1);
  const unknown = finishAccountDeletionAttempt(
    markAccountDeletionExecutionDispatched(first, first.runId),
    first.runId,
    { ok: false, reason: 'unknown' },
  );
  const retry = beginAccountDeletionAttempt(unknown, 2);
  expect(finishAccountDeletionAttempt(retry, retry.runId, { ok: true, accountId: 'other-account' })).toMatchObject({
    phase: 'unknown',
    uncertain: true,
  });
  expect(finishAccountDeletionAttempt(retry, retry.runId, { ok: true, accountId: operation.accountId })).toMatchObject({
    operation,
    operationKey: key,
    phase: 'committed',
    submitted: true,
    uncertain: false,
  });
});

test('retirement and restoration keep conservative submitted hints without inventing phase history', () => {
  const unsent = createAccountDeletionAttempt(operation.accountId, key);
  expect(retireAccountDeletionAttempt(unsent).phase).toBe('review');
  const running = beginAccountDeletionAttempt(unsent, 1);
  expect(retireAccountDeletionAttempt(running).phase).toBe('review');
  const executing = markAccountDeletionExecutionDispatched(running, running.runId);
  expect(retireAccountDeletionAttempt(executing)).toMatchObject({ phase: 'unknown', submitted: true, uncertain: true });
  expect(
    restoreAccountDeletionAttempt({
      kind: 'delete',
      accountId: operation.accountId,
      operationKey: key,
      operation,
      returnTo: '/account/delete',
    }),
  ).toMatchObject({ phase: 'unknown', submitted: true, uncertain: true, hintOnly: true });
  expect(
    restoreAccountDeletionAttempt({
      kind: 'delete',
      accountId: operation.accountId,
      operationKey: key,
      operation,
      returnTo: '/account/delete',
      submitted: false,
    }),
  ).toMatchObject({ phase: 'review', submitted: false, uncertain: false, hintOnly: false });
});

test('a late completion from an older generation cannot replace the current attempt', () => {
  const original = beginAccountDeletionAttempt(createAccountDeletionAttempt(operation.accountId, key), 1);
  const current = beginAccountDeletionAttempt(original, 2);
  expect(finishAccountDeletionAttempt(current, original.runId, { ok: true, accountId: operation.accountId })).toBe(
    current,
  );
  expect(current).toMatchObject({ generation: 2, phase: 'approval', uncertain: false });
});
