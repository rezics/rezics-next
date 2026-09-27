import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { REALM_READ_COST } from '../src/modules/realm-reads/read-contract.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved }
  from '../src/modules/work/read-session.ts';

test('Realm cursor binds its Realm, collection and graph position', () => {
  const position = { dataEpoch: 'epoch', sequence: '17' };
  const cursor = encodeReadCursor(['realm-decisions-v1', 'private-realm'], position, 'private-decision', '0:12');
  expect(cursor).not.toContain('private');
  expect(decodeReadCursor(cursor, ['realm-decisions-v1', 'private-realm'], position)?.order).toBe('0:12');
  expect(() => decodeReadCursor(cursor, ['realm-works-v1', 'private-realm'], position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, ['realm-decisions-v1', 'other'], position)).toThrow(WorkReadInvalid);
  expect(() => decodeReadCursor(cursor, ['realm-decisions-v1', 'private-realm'],
    { ...position, sequence: '18' })).toThrow(WorkReadMoved);
  expect(REALM_READ_COST.pageSize).toBe(20);
  expect(REALM_READ_COST.candidateRows).toBe(21);
});

test('Realm reads are concrete in the web-style MainApp treaty', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedReads = async () => {
    const realm = client.v1.realms({ realm: '00000000-0000-4000-8000-000000000001' });
    const header = await realm.get({ query: { language: 'zh-CN' } });
    const name: string | undefined = header.data?.name.value;
    const countKind: 'unknown' | 'estimated' | 'exact' | undefined = header.data?.membership.count.kind;
    const works = await realm.works.get({ query: { limit: 2 } });
    const selection: string | undefined = works.data?.items[0]?.selection;
    const decisions = await realm.decisions.get({ query: { limit: 2 } });
    const next: string | null | undefined = decisions.data?.nextCursor;
    return { name, countKind, selection, next };
  };
  expect(typedReads).toBeFunction();
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/realm-read' },
  account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(gets).toContain('/v1/realms/:realm');
  expect(gets).toContain('/v1/realms/:realm/works');
  expect(gets).toContain('/v1/realms/:realm/decisions');
});
