import { describe, expect, test } from 'bun:test';
import { directoryParams, readState, sameSearch, stateHref } from './state.ts';

describe('directory URL state', () => {
  test('defaults are left out of the URL and restored from it', () => {
    const initial = readState({});
    expect(initial).toEqual({ text: '', sort: 'createdAt', direction: 'desc', cursor: null });
    expect(stateHref(initial)).toBe('/admin/users');
    const named = { text: 'status:suspended ada', sort: 'name' as const, direction: 'asc' as const, cursor: 'c1' };
    expect(stateHref(named)).toBe('/admin/users?q=status%3Asuspended+ada&sort=name&cursor=c1');
    expect(readState(new URLSearchParams(stateHref(named).split('?')[1]))).toEqual(named);
    expect(readState({ sort: 'created', dir: 'asc' })).toMatchObject({ sort: 'createdAt', direction: 'asc' });
    expect(readState({ sort: 'lastSignIn', dir: 'sideways' })).toMatchObject({ sort: 'createdAt', direction: 'desc' });
  });

  test('the search text becomes the service query', () => {
    expect(directoryParams({ text: 'role:staff -status:suspended', sort: 'email', direction: 'asc', cursor: null })).toEqual({
      role: 'owner,admin,support', status: 'active,password-reset-required', sort: 'email', direction: 'asc', limit: 25 });
    expect(sameSearch(' status:suspended   ada ', 'status:suspended ada')).toBe(true);
  });
});
