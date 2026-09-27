import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { REALM_DIRECTORY_COST } from '../src/modules/realm-directory/contract.ts';
import { searchText } from '../src/modules/realm-directory/read.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved }
  from '../src/modules/work/read-session.ts';

test('Realm directory search handles contiguous Han and Unicode compatibility characters', () => {
  expect(searchText('读者公会', '者公')).toBe(true);
  expect(searchText('Readers Guild', 'ｇｕｉｌｄ')).toBe(true);
  expect(searchText('一起阅读。', '阅读')).toBe(true);
  expect(searchText('读者公会', '图书')).toBe(false);
});

test('Realm directory cursor binds search, order, language and graph position', () => {
  const position = { dataEpoch: 'epoch', sequence: '17' };
  const binding = ['realm-directory-v1', 'members', '读者', 'zh-CN'];
  const cursor = encodeReadCursor(binding, position, 'private-realm');
  expect(cursor).not.toContain('private-realm');
  expect(decodeReadCursor(cursor, binding, position)?.after).toBe('private-realm');
  expect(() => decodeReadCursor(cursor, ['realm-directory-v1', 'newest', '读者', 'zh-CN'],
    position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, ['realm-directory-v1', 'members', 'other', 'zh-CN'],
    position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, binding, { ...position, sequence: '18' })).toThrow(WorkReadMoved);
  expect(REALM_DIRECTORY_COST.sourceBatch).toBe(32);
});

test('Realm directory is a public typed Main route', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedRead = async () => {
    const page = await client.v1.realms.get({ query: { sort: 'members', q: '阅读',
      language: 'zh-CN', limit: 5 } });
    const name: string | undefined = page.data?.items[0]?.name.value;
    const countKind: 'unknown' | 'estimated' | 'exact' | undefined = page.data?.items[0]?.membership.count.kind;
    return { name, countKind };
  };
  expect(typedRead).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/realm-directory' },
  account: {} as never, access: {} as never });
  expect(app.routes.some(route => route.method === 'GET' && route.path === '/v1/realms')).toBe(true);
});
