import { expect, test } from 'bun:test';
import { newestRoleList, readRoles } from '../features/manage/read.ts';
import type { MainClient, RoleList } from '../features/manage/types.ts';

const empty: RoleList = { generation: '12', cap: 32, roles: [] };
const saved: RoleList = { generation: '13', cap: 32, roles: [{
  id: '00000000-0000-4000-8000-000000000001', name: 'Translators',
  permissions: ['rating.question-presentation.review'], holders: [], moreHolders: false,
}] };

test('a confirmed post-save role list survives a refresh with pre-save props', () => {
  expect(newestRoleList(empty, null)).toBe(empty);
  expect(newestRoleList(empty, saved)).toBe(saved);
  expect(newestRoleList(empty, saved).roles[0]?.name).toBe('Translators');
});

test('a current route read supersedes the saved list, including concurrent edits or removal', () => {
  expect(newestRoleList({ ...saved }, saved)).not.toBe(saved);
  const removed = { ...empty, generation: '14' };
  expect(newestRoleList(removed, saved)).toBe(removed);
});

test('role generation ordering stays exact above the JavaScript integer limit', () => {
  const older = { ...empty, generation: '9007199254740992' };
  const newer = { ...saved, generation: '9007199254740993' };
  expect(newestRoleList(older, newer)).toBe(newer);
});

test('the roles read uses the same Realm and acting subject and preserves a role with no holders', async () => {
  const calls: unknown[] = [];
  const main = { v1: { realms: (params: unknown) => ({ roles: { get: async (options: unknown) => {
    calls.push({ params, options });
    return { data: saved, error: null };
  } } }) } } as unknown as MainClient;
  expect(await readRoles(main, 'realm-id', 'acting-agent')).toEqual({ ok: true, data: saved });
  expect(calls).toEqual([{ params: { realm: 'realm-id' }, options: { query: { actingSubject: 'acting-agent' } } }]);
});
