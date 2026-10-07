import { describe, expect, test } from 'bun:test';
import {
  gateFor,
  NO_PLATFORM_ACCESS,
  operationOpen,
  parsePlatformAccess,
  platformClosed,
} from '../features/api/platform-access.ts';
import { failureOf as realmFailureOf } from '../features/realm/types.ts';
import { failureOf, settle } from '../features/feed/types.ts';
import { commandFailure, mainSavedFilterApi } from '../features/saved-filter/api.ts';
import type { MainClient } from '../features/feed/types.ts';

const closedBody = { type: 'https://rezics.com/problems/platform_closed', status: 403, code: 'platform_closed' };
const savedViews = { groups: ['saved-views'], operations: [], generation: '7' };

describe('operationOpen', () => {
  test('public operations are open to anyone, including a viewer whose access could not be read', () => {
    expect(operationOpen('getV1Types', NO_PLATFORM_ACCESS)).toBe(true);
    expect(operationOpen('getV1Types', null)).toBe(true);
  });

  test('a platform operation is closed without its group and open with it', () => {
    expect(operationOpen('getV1MeSaved-filters', null)).toBe(false);
    expect(operationOpen('getV1MeSaved-filters', NO_PLATFORM_ACCESS)).toBe(false);
    expect(operationOpen('getV1MeSaved-filters', savedViews)).toBe(true);
    expect(operationOpen('getV1MeSaved-filters', { ...savedViews, groups: ['commerce'] })).toBe(false);
  });

  test('a single operation can be open without its group', () => {
    const one = { groups: [], operations: ['getV1MeSaved-filters'], generation: '1' };
    expect(operationOpen('getV1MeSaved-filters', one)).toBe(true);
    expect(operationOpen('postV1MeSaved-filters', one)).toBe(false);
    expect(gateFor(one)('putV1MeSaved-filtersOrder')).toBe(false);
  });
});

describe('platform access read', () => {
  test('takes the contract shape and nothing else', () => {
    expect(parsePlatformAccess(savedViews)).toEqual(savedViews);
    expect(parsePlatformAccess({ groups: [], operations: [], generation: '' })).toEqual(NO_PLATFORM_ACCESS);
    for (const bad of [null, 'groups', {}, { groups: ['a'], operations: [] }, { groups: [1], operations: [], generation: '' }])
      expect(parsePlatformAccess(bad)).toBeNull();
  });
});

describe('the closed outcome', () => {
  test('only Main’s 403 platform_closed is closed; another 403 is still a refusal of the session', () => {
    expect(platformClosed(403, closedBody)).toBe(true);
    expect(platformClosed(403, { code: 'forbidden' })).toBe(false);
    expect(platformClosed(401, closedBody)).toBe(false);
    expect(platformClosed(403, undefined)).toBe(false);
    expect(failureOf(403, closedBody)).toBe('closed');
    expect(failureOf(403, { code: 'forbidden' })).toBe('sign-in');
    expect(realmFailureOf(403, closedBody)).toBe('closed');
    expect(realmFailureOf(403)).toBe('missing');
    expect(commandFailure(403, 'platform_closed')).toBe('closed');
    expect(commandFailure(403, 'forbidden')).toBe('sign-in');
  });

  test('a shared read turns the closed refusal into a typed outcome, never a throw', async () => {
    const read = await settle(async () => ({ data: null, error: { status: 403, value: closedBody } }));
    expect(read).toEqual({ ok: false, failure: 'closed' });
  });
});

describe('Saved Filter client', () => {
  const answer = (error: { status: number; value: unknown } | null) => async () => ({
    data: error ? null : { profile: 'saved-filters-v1', revision: null, items: [], cursor: null, complete: true },
    error,
  });
  function client(calls: string[], error: { status: number; value: unknown } | null) {
    const call = (name: string) => () => {
      calls.push(name);
      return answer(error)();
    };
    const route = Object.assign(
      (params: { id: string }) => ({ patch: call(`patch:${params.id}`), delete: call(`delete:${params.id}`) }),
      { get: call('get'), post: call('post'), order: { put: call('order') } },
    );
    return { v1: { me: { 'saved-filters': route } } } as unknown as MainClient;
  }
  const filter = { id: 'f1', revision: 'r1' } as Parameters<ReturnType<typeof mainSavedFilterApi>['update']>[0];

  test('a closed operation is answered closed without a request', async () => {
    const calls: string[] = [];
    const api = mainSavedFilterApi('agent', client(calls, null), gateFor(NO_PLATFORM_ACCESS));
    expect(await api.list('en')).toEqual({ ok: false, failure: 'closed' });
    expect(await api.create({ name: 'n', filter: { all: [] } as never, pinned: true })).toEqual({
      ok: false,
      failure: 'closed',
    });
    expect(await api.update(filter, { pinned: false })).toEqual({ ok: false, failure: 'closed' });
    expect(await api.reorder(['f1'], 'r')).toEqual({ ok: false, failure: 'closed' });
    expect(await api.remove(filter)).toEqual({ ok: false, failure: 'closed' });
    expect(calls).toEqual([]);
  });

  test('only the operations that are open are called', async () => {
    const calls: string[] = [];
    const api = mainSavedFilterApi(
      'agent',
      client(calls, null),
      gateFor({ groups: [], operations: ['getV1MeSaved-filters'], generation: '1' }),
    );
    expect((await api.list('en')).ok).toBe(true);
    expect(await api.update(filter, { pinned: false })).toEqual({ ok: false, failure: 'closed' });
    expect(calls).toEqual(['get']);
  });

  test('a grant revoked between the access read and the call is closed, not an error', async () => {
    const calls: string[] = [];
    const api = mainSavedFilterApi('agent', client(calls, { status: 403, value: closedBody }), gateFor(savedViews));
    expect(await api.list('en')).toEqual({ ok: false, failure: 'closed' });
    expect(await api.update(filter, { pinned: false })).toEqual({ ok: false, failure: 'closed' });
    expect(await api.remove(filter)).toEqual({ ok: false, failure: 'closed' });
    expect(calls).toEqual(['get', 'patch:f1', 'delete:f1']);
  });
});
