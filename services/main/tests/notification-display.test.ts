import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { notificationRealmDisplay, notificationRoleName, notificationWorkTitle }
  from '../src/modules/notification/display.ts';

const realm = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const work = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';

test('G-329: disclosed Realm and Work display carries a current name, route segment and target title', async () => {
  const queries: string[] = [];
  const env = { fuseki: { query: async (query: string) => {
    queries.push(query);
    if (query.includes('rv:publicProfileHead')) return { results: { bindings: [{}] } };
    if (query.includes('SELECT ?name ?space')) return { results: { bindings: [
      { name: { value: 'Fiction · 小说' }, space: { value: realm } }] } };
    return { results: { bindings: [{ title: { value: 'A novel' } }] } };
  } }, addresses: { currents: async (holders: string[]) => {
    expect(holders).toEqual([realm]);
    return new Map([[`space\0${realm}`,{ key: 'fiction' }]]);
  } } } as unknown as WorkActivationEnvironment;
  expect(await notificationRealmDisplay(env, realm)).toEqual({ realmName: 'Fiction · 小说',
    realmRouteSegment: 'fiction' });
  expect(await notificationWorkTitle(env, work)).toBe('A novel');
  expect(queries.at(-1)).toContain('rv:disclosure');
});

test('G-329: a receipt preserves the role name and ambiguous legacy assignments do not guess', async () => {
  const access = { query: async () => ({ rows: [{ name: 'Moderator' }, { name: 'Editor' }] }) } as unknown as Pool;
  expect(await notificationRoleName(access, realm, work, { name: 'Moderator' })).toBe('Moderator');
  expect(await notificationRoleName(access, realm, work, null)).toBeNull();
});
