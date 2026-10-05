import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { REALM_DIRECTORY_COST } from '../src/modules/realm-directory/contract.ts';
import { readRealmDirectory, searchText } from '../src/modules/realm-directory/read.ts';
import { readSharedVocabulary } from '../src/modules/realm-directory/vocabulary.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved }
  from '../src/modules/work/read-session.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { RealmDirectoryIndex } from '../src/modules/realm-directory/index.ts';
import { prepareRealmHistoryAdmission, recordRealmHistoryAdmission, RealmHistoryAdmissionStale }
  from '../src/modules/realm-admin/history.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('Realm directory pages use the last built position and perform no graph reads or row locking', async () => {
  const queries: string[] = [];
  let countRevision = '4';
  const query = async (sql: string) => {
    queries.push(sql);
    let rows: object[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{ id: true }];
    else if (sql.includes('FROM access.realm_directory_position')) rows = [{ data_epoch: 'epoch', sequence: '17', generation: 1,
      phase: 'graph', target_sequence: '23', rebuilding: true }];
    else if (sql.includes('FROM access.realm_count_position')) rows = [{ revision: countRevision }];
    else if (sql.includes('FROM access.realm_directory d')) rows = [
      { realm: 'one', rank: '-7', count_value: '2', count_revision: '4' },
      { realm: 'two', rank: '-6', count_value: '1', count_revision: '3' },
    ];
    return { rows, rowCount: rows.length };
  };
  const index = new RealmDirectoryIndex({ connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const session = { options: {}, position: { dataEpoch: 'epoch', sequence: '23' },
    query: () => { throw new Error('GET must not refresh Fuseki'); } } as never;
  const page = await index.page(session, { sort: 'members', q: '', limit: 1 });
  expect(page.sourcePosition).toEqual({ dataEpoch: 'epoch', sequence: '17' });
  expect(page.rows).toHaveLength(1);
  expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(queries.some(sql => /FOR (UPDATE|SHARE)|^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  expect(decodeReadCursor(page.next!, ['realm-directory-v3', 'members', '', null, null], page.sourcePosition)?.after).toBe('one');
  countRevision = '5';
  await expect(index.page(session, { sort: 'members', q: '', limit: 1, cursor: page.next! })).rejects.toBeInstanceOf(WorkReadMoved);
  await expect(index.page(session, { sort: 'members', q: '', cursor: 'invalid' })).rejects.toBeInstanceOf(WorkReadInvalid);
});

test('Realm directory first pages retain their published snapshot while continuations fence later publications', async () => {
  const sourcePosition = { dataEpoch: 'epoch', sequence: '17' };
  let published = '17', revision = '4', changeMembership = false;
  const query = async (sql: string) => {
    let rows: object[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{}];
    else if (sql.includes('FROM access.realm_directory_position')) rows = [{ data_epoch: 'epoch', sequence: published, generation: 1 }];
    else if (sql.includes('FROM access.realm_count_position')) rows = [{ revision }];
    return { rows, rowCount: rows.length };
  };
  const index = new RealmDirectoryIndex({ query, connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const session = { options: {} as { cursor?: string }, position: { dataEpoch: 'epoch', sequence: '23' },
    summaries: async () => { published = '18'; if (changeMembership) revision = '5'; return []; },
    deps: { environment: {}, access: { realmDirectory: index } } } as unknown as WorkReadSession;
  expect((await readRealmDirectory(session, { sort: 'members' })).sourcePosition).toEqual(sourcePosition);
  published = '17';
  session.options.cursor = encodeReadCursor(['realm-directory-v3', 'members', '', null, null], sourcePosition, 'one', '4:-7');
  await expect(readRealmDirectory(session, { sort: 'members' })).rejects.toBeInstanceOf(WorkReadMoved);
  session.options.cursor = undefined;
  published = '17'; changeMembership = true;
  await expect(readRealmDirectory(session, { sort: 'members' })).rejects.toBeInstanceOf(WorkReadMoved);
});

test('Realm history cuts are prepared outside the transaction and reject changed recovery, policy or epoch locally', async () => {
  let transaction = false, recovery = '4', restricted = true, graphCalls = 0;
  const writes: unknown[][] = [];
  const pool = { query: async () => ({ rows: [{ generation: recovery, restricted }] }) } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query: async () => {
    if (transaction) throw new Error('Graph HTTP while holding membership locks');
    graphCalls++;
    return { results: { bindings: [{ sequence: { value: '17' } }] } };
  } } } as unknown as WorkActivationEnvironment;
  const client = { query: async (sql: string, values: unknown[] = []) => {
    let rows: object[] = [];
    if (sql.includes('SELECT 1 FROM access.recovery_fence')) rows = recovery === values[0] ? [{}] : [];
    else if (sql.includes('SELECT history')) rows = [{ history: restricted ? 'from-admission' : 'everything' }];
    else if (sql.includes('INSERT INTO access.realm_history_admission')) { writes.push(values); rows = [{}]; }
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  const cut = await prepareRealmHistoryAdmission(pool, env, 'realm');
  transaction = true;
  await recordRealmHistoryAdmission(client, env, 'realm', 'agent', 'episode', '1', cut);
  expect(writes[0]).toEqual(['agent', 'episode', '1', 'epoch', '17', '4']);
  recovery = '6';
  await expect(recordRealmHistoryAdmission(client, env, 'realm', 'private', 'other', '1', cut))
    .rejects.toBeInstanceOf(RealmHistoryAdmissionStale);
  recovery = '4'; restricted = false;
  await expect(recordRealmHistoryAdmission(client, env, 'realm', 'agent', 'other', '1', cut))
    .rejects.toBeInstanceOf(RealmHistoryAdmissionStale);
  restricted = true; env.lineage.dataEpoch = 'restored';
  await expect(recordRealmHistoryAdmission(client, env, 'realm', 'agent', 'other', '1', cut))
    .rejects.toBeInstanceOf(RealmHistoryAdmissionStale);
  expect(graphCalls).toBe(1);
  expect(writes).toHaveLength(1);
});

test('Realm history preparation for everything episodes needs no Fuseki call', async () => {
  const pool = { query: async () => ({ rows: [{ generation: '4', restricted: false }] }) } as unknown as Pool;
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query: () => {
    throw new Error('Unrestricted join must not wait on the history graph');
  } } } as unknown as WorkActivationEnvironment;
  expect(await prepareRealmHistoryAdmission(pool, env, 'realm')).toMatchObject({ restricted: false, recoveryGeneration: '4' });
});

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
  expect(app.routes.some(route => route.method === 'GET' && route.path === '/v1/classification-vocabulary'))
    .toBe(true);
});

test('community topics use the current shared vocabulary and match both languages', async () => {
  const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const session = { displayLanguages: ['zh-CN'], query: async (sparql: string) => {
    expect(sparql).toContain('rv:VocabularyDefinition');
    return [{ concept: { value: id }, label: { value: 'Mystery', 'xml:lang': 'en' } },
      { concept: { value: id }, label: { value: '悬疑', 'xml:lang': 'zh-Hans' } }];
  } } as never;
  expect((await readSharedVocabulary(session, 'Myst')).items).toEqual([{ id, label: '悬疑' }]);
  expect((await readSharedVocabulary(session, '悬疑')).items).toEqual([{ id, label: '悬疑' }]);
  expect((await readSharedVocabulary(session, 'Fantasy')).items).toEqual([]);
});
