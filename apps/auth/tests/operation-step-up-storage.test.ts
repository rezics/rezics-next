import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { loadAccountSession } from '../src/account-operations';
import {
  ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT,
  pendingAccountOperationStepUpState,
  selectAccountOperationStepUp,
  storePendingAccountOperationStepUp,
} from '../src/account-operation-step-up';
import {
  MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT,
  RENAME_REVIEW_STEP_UP_STORAGE_LIMIT,
  consumeRenameReviewReturn,
  markManagementOpeningSubmitted,
  markManagementOperationReturned,
  markRenameReviewReturned,
  pendingManagementOperationStepUpState,
  pendingRenameReviewStepUpState,
  selectManagementOperationStepUp,
  storePendingManagementOperationStepUp,
  storePendingRenameReviewStepUp,
} from '../src/management-operation-step-up';
import type { ManagementOperationInput } from '@rezics/auth-contract';

const accountStorageKey = 'rezics.account-operation.step-up';
const managementStorageKey = 'rezics.management-operation.step-up';
const reviewStorageKey = 'rezics.management-operation.review-step-up';
const accountReturnQuery = 'account_operation=delete&return_to=%2Faccount%2Fdelete';
const managementReturnQuery = 'management_operation=rename&return_to=%2Faccount%2Frename';
const reviewAccountId = '00000000-0000-4000-8000-000000000001';
const data = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let failGet = false;
let failSet = false;
let writes = 0;
let removals = 0;
const storage = {
  getItem(key: string) {
    if (failGet) throw new Error('storage read failed');
    return data.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    writes++;
    if (failSet) throw new Error('storage write failed');
    data.set(key, value);
  },
  removeItem(key: string) {
    removals++;
    data.delete(key);
  },
};
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { sessionStorage: storage },
});
afterEach(() => {
  data.clear();
  failGet = false;
  failSet = false;
  writes = 0;
  removals = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function atLimit(value: unknown, limit: number): string {
  const raw = JSON.stringify(value);
  if (raw.length > limit) throw new Error('fixture exceeds storage limit');
  return raw + ' '.repeat(limit - raw.length);
}

test('all retained readers reject oversized malformed data before parsing and preserve it', () => {
  const account = '['.repeat(ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT + 1);
  const management = '['.repeat(MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT + 1);
  const review = '['.repeat(RENAME_REVIEW_STEP_UP_STORAGE_LIMIT + 1);
  data.set(accountStorageKey, account);
  data.set(managementStorageKey, management);
  data.set(reviewStorageKey, review);
  const parse = spyOn(JSON, 'parse');

  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'invalid' });
  expect(selectAccountOperationStepUp(accountReturnQuery)).toEqual({ kind: 'invalid' });
  expect(selectManagementOperationStepUp(managementReturnQuery)).toEqual({ kind: 'invalid' });
  expect(parse).not.toHaveBeenCalled();
  expect(data).toEqual(
    new Map([
      [accountStorageKey, account],
      [managementStorageKey, management],
      [reviewStorageKey, review],
    ]),
  );
  expect(writes).toBe(0);
  expect(removals).toBe(0);
  parse.mockRestore();
});

test('each envelope admits a valid JSON value exactly at its UTF-16 code-unit limit', () => {
  const account = {
    kind: 'delete',
    accountId: 'account',
    operationKey: 'a'.repeat(32),
    operation: { kind: 'delete', accountId: 'account' },
    returnTo: '/account/delete',
    version: 1,
  };
  const management = {
    accountId: 'human',
    kind: 'rename',
    operation: { kind: 'rename', accountId: 'target', handle: 'abc', expectedHandle: null },
    operationKey: 'key',
    returnTo: '/account/rename',
    phase: 'awaiting',
    version: 1,
  };
  const review = {
    accountId: reviewAccountId,
    kind: 'rename',
    returnTo: '/account/rename',
    phase: 'awaiting',
    version: 1,
  };
  data.set(accountStorageKey, atLimit(account, ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT));
  data.set(managementStorageKey, atLimit(management, MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT));
  data.set(reviewStorageKey, atLimit(review, RENAME_REVIEW_STEP_UP_STORAGE_LIMIT));
  expect(pendingAccountOperationStepUpState()).toMatchObject({ kind: 'pending', value: { kind: 'delete' } });
  expect(pendingManagementOperationStepUpState()).toMatchObject({ kind: 'pending', value: { kind: 'rename' } });
  expect(pendingRenameReviewStepUpState()).toMatchObject({ kind: 'pending', value: { phase: 'awaiting' } });

  const parse = spyOn(JSON, 'parse');
  data.set(accountStorageKey, `${data.get(accountStorageKey)} `);
  data.set(managementStorageKey, `${data.get(managementStorageKey)} `);
  data.set(reviewStorageKey, `${data.get(reviewStorageKey)} `);
  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'invalid' });
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();
});

test('account compatibility is closed and the optional submitted marker stays optional', () => {
  const account = {
    kind: 'delete',
    accountId: 'account',
    operationKey: 'a'.repeat(32),
    operation: { kind: 'delete', accountId: 'account' },
    returnTo: '/account/delete',
    version: 1,
  };
  data.set(accountStorageKey, JSON.stringify(account));
  expect(pendingAccountOperationStepUpState()).toMatchObject({ kind: 'pending', value: { kind: 'delete' } });
  data.set(accountStorageKey, JSON.stringify({ ...account, authorization: 'private' }));
  const unknown = data.get(accountStorageKey);
  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(data.get(accountStorageKey)).toBe(unknown);
  const stringify = spyOn(JSON, 'stringify');
  const invalidAccount = {
    kind: 'delete',
    accountId: 'account',
    operationKey: 'a'.repeat(32),
    operation: { kind: 'delete', accountId: 'account' },
    authorization: 'private',
  } as never;
  expect(storePendingAccountOperationStepUp(invalidAccount)).toBe(false);
  expect(data.get(accountStorageKey)).toBe(unknown);
  data.set(managementStorageKey, 'previous-management-value');
  const invalidManagement = {
    accountId: 'human',
    operationKey: 'key',
    operation: { kind: 'opening', operatorAccountId: 'operator', subjectAccountId: 'subject' },
    authorization: 'private',
  } as never;
  expect(storePendingManagementOperationStepUp(invalidManagement)).toBe(false);
  expect(stringify).not.toHaveBeenCalled();
  expect(data.get(managementStorageKey)).toBe('previous-management-value');
  stringify.mockRestore();
  expect(writes).toBe(0);
});

test('producers bound escaping at legal field maxima and round-trip every management variant', () => {
  const escaped = '\u0000'.repeat(4096);
  expect(
    storePendingAccountOperationStepUp({
      kind: 'delete',
      accountId: escaped,
      operationKey: 'a'.repeat(32),
      operation: { kind: 'delete', accountId: escaped },
      submitted: true,
    }),
  ).toBe(true);
  const accountRaw = data.get(accountStorageKey)!;
  expect(accountRaw.length).toBeLessThanOrEqual(ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT);
  expect(pendingAccountOperationStepUpState()).toMatchObject({ kind: 'pending', value: { submitted: true } });
  const handle = `a${'x'.repeat(62)}z`;
  expect(
    storePendingAccountOperationStepUp({
      kind: 'organization',
      accountId: 'human',
      operationKey: 'b'.repeat(32),
      operation: { kind: 'organization', handle },
    }),
  ).toBe(true);
  expect(pendingAccountOperationStepUpState()).toMatchObject({ kind: 'pending', value: { operation: { handle } } });

  const largest: ManagementOperationInput = {
    accountId: escaped,
    operationKey: escaped,
    operation: {
      kind: 'transfer-acceptance',
      previous: { operatorAccountId: escaped, subjectAccountId: escaped, reservationId: escaped },
      expectedVersion: escaped,
      operatorAccountId: escaped,
      sourceOperationKey: escaped,
    },
  };
  expect(storePendingManagementOperationStepUp(largest)).toBe(true);
  const managementRaw = data.get(managementStorageKey)!;
  expect(managementRaw.length).toBeLessThanOrEqual(MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT);
  expect(pendingManagementOperationStepUpState()).toMatchObject({ kind: 'pending', value: largest });

  const operations: ManagementOperationInput['operation'][] = [
    { kind: 'opening', operatorAccountId: 'operator', subjectAccountId: 'subject' },
    { kind: 'rename', accountId: 'target', handle: 'abc', expectedHandle: null },
    {
      kind: 'membership',
      organizationId: 'organization',
      memberAccountId: 'member',
      role: 'member',
      reservationId: 'reservation',
    },
    {
      kind: 'transfer',
      previous: { operatorAccountId: 'old-operator', subjectAccountId: 'subject', reservationId: 'reservation' },
      expectedVersion: 'v1',
      operatorAccountId: 'new-operator',
      acceptance: 'acceptance',
    },
    {
      kind: 'transfer-acceptance',
      previous: { operatorAccountId: 'old-operator', subjectAccountId: 'subject', reservationId: 'reservation' },
      expectedVersion: 'v2',
      operatorAccountId: 'new-operator',
      sourceOperationKey: 'source-key',
    },
  ];
  for (const operation of operations) {
    const input = { accountId: 'human', operationKey: 'request', operation };
    expect(storePendingManagementOperationStepUp(input)).toBe(true);
    expect(pendingManagementOperationStepUpState()).toMatchObject({ kind: 'pending', value: input });
    if (operation.kind === 'opening') {
      const state = pendingManagementOperationStepUpState();
      expect(state.kind === 'pending' && markManagementOperationReturned(state.value)).toBe(true);
      expect(markManagementOpeningSubmitted(input)).toBe(true);
      expect(pendingManagementOperationStepUpState()).toMatchObject({ kind: 'pending', value: { phase: 'submitted' } });
    }
  }
});

test('rename review consumption is deliberate and account-bound', () => {
  expect(storePendingRenameReviewStepUp(reviewAccountId)).toBe(true);
  expect(
    markRenameReviewReturned({
      kind: 'rename',
      accountId: reviewAccountId,
      returnTo: '/account/rename',
      phase: 'awaiting',
    }),
  ).toBe(true);
  expect(consumeRenameReviewReturn('00000000-0000-4000-8000-000000000002')).toBe(false);
  expect(pendingRenameReviewStepUpState()).toMatchObject({
    kind: 'pending',
    value: { accountId: reviewAccountId, phase: 'returned' },
  });
  expect(consumeRenameReviewReturn(reviewAccountId)).toBe(true);
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'absent' });
});

test('malformed, absent and inaccessible storage keep their established distinctions', async () => {
  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'absent' });
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'absent' });
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'absent' });
  data.set(accountStorageKey, '{');
  data.set(managementStorageKey, '{');
  data.set(reviewStorageKey, '{');
  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'invalid' });
  const parse = spyOn(JSON, 'parse');
  failGet = true;
  expect(pendingAccountOperationStepUpState()).toEqual({ kind: 'absent' });
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'invalid' });
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'invalid' });
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();
  failGet = false;
  failSet = true;
  expect(storePendingRenameReviewStepUp(reviewAccountId)).toBe(false);
  expect(
    markRenameReviewReturned({
      kind: 'rename',
      accountId: reviewAccountId,
      returnTo: '/account/rename',
      phase: 'awaiting',
    }),
  ).toBe(false);
  expect(data.get(reviewStorageKey)).toBe('{');
});

test('the account session producer rejects IDs above the existing 4,096-code-unit descriptor ceiling', async () => {
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ account_id: 'x'.repeat(4096) }))
    .mockResolvedValueOnce(Response.json({ account_id: 'x'.repeat(4097) }));
  expect(await loadAccountSession()).toEqual({ kind: 'ready', accountId: 'x'.repeat(4096) });
  expect(await loadAccountSession()).toMatchObject({ kind: 'failure' });
  fetch.mockRestore();
});
