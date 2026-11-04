import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import { fromPlainText } from '@rezics/document';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { anchorRoute, routeOf, newId } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const routeKey = new Uint8Array(32).fill(4);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = [
  'subject:create',
  'subject:read',
  'subject:batch_write',
  'statement:propose',
  'moderation:hide',
  'moderation:takedown',
];
const accounts = {
  importer: newId(0x1a00),
  editor: newId(0xed17),
  moderator: newId(0x0d00),
};
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  receiptKeys: testReceiptKeys(),
  routeKey,
  writeRate: realAccess.writeRate,
});

beforeAll(async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of ['subject:create', 'statement:propose', 'subject:batch_write'])
    await realAccess.grant(global, 'importer', action);
  for (const action of ['subject:create', 'statement:propose']) await realAccess.grant(global, 'editor', action);
  await realAccess.grant(global, 'moderator', 'moderation:takedown');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) {
    const token = Object.hasOwn(accounts, options.token)
      ? realAccess.bearer(options.token as keyof typeof accounts)
      : options.token;
    headers.authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    if (!path.endsWith(':batchWrite')) headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const batch = (commands: unknown[], token = 'importer') =>
  call('POST', '/v1/subjects:batchWrite', { token, body: { commands } });
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const record = (externalId: string, overrides: Partial<Source> = {}): Source => ({
  source: 'openlibrary',
  external_id: externalId,
  record_revision: 'unversioned',
  digest: 'c'.repeat(64),
  converter_revision: 'openlibrary@1',
  field_group: 'facts',
  ...overrides,
});
const cited = (property: string, content: unknown, url = 'https://openlibrary.org/works/OL1W') => ({
  ...statement(property, content),
  references: [{ parts: [statement('schema:url', url)] }],
});
const work = (title: string) => ({ type: 'schema:Book', labels: { en: title } });
const results = (body: Record<string, any>) =>
  (body.results as Record<string, any>[]).map(({ key, status, value: result, problem }) =>
    problem ? { key, status, code: problem.code } : { key, status, value: result },
  );

async function stableBatch(commands: BatchCommand[]) {
  let response: Response | undefined;
  const port = createImportTransport({
    origin: 'http://kernel.test',
    tokenProvider: async () => realAccess.bearer('importer'),
    fetch: async (input, init) => {
      response = await kernel.handle(input instanceof Request ? input : new Request(input, init));
      return response;
    },
  });
  const body = await port.batch({ commands });
  return { response: response!, body };
}

test('native sourced batch create, proposal and replay retain command history and one result per command', async () => {
  const externalId = `OL${randomUUID()}W`;
  const author = (
    await call('POST', '/v1/subjects', {
      token: 'editor',
      body: { type: 'schema:Person', labels: { en: 'Natsume Soseki' } },
    })
  ).body.subject as Record<string, any>;
  const commands: BatchCommand[] = [
    { op: 'create', key: 'create-facts', source: record(externalId), subject: work('Kokoro') },
    { op: 'create', key: 'create-again', source: record(externalId), subject: work('Kokoro (duplicate)') },
    {
      op: 'propose',
      key: 'author',
      source: record(`${externalId}-author`),
      subject: author.id,
      statement: cited('schema:birthDate', {
        time: '+1867-02-09T00:00:00Z',
        precision: 11,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      }),
    },
  ] as BatchCommand[];
  const first = await stableBatch(commands);
  expect(first.response.status).toBe(200);
  expect(first.response.headers.get('rezics-session-token')).toBeString();
  const id = first.body.results[0].value.id as string;
  expect(routeOf(id)).toBe(anchorRoute(routeKey, `openlibrary\n${externalId}`));
  expect(results(first.body)).toEqual([
    { key: 'create-facts', status: 201, value: { id, revision: 1 } },
    { key: 'create-again', status: 200, value: { id, revision: 1 } },
    { key: 'author', status: 201, value: { candidate: expect.any(String), revision: 2 } },
  ]);

  const replay = await stableBatch(commands);
  expect(replay.body).toEqual(first.body);
  const rerun = await batch([
    { op: 'create', key: 'rerun', source: record(externalId, { record_revision: '2' }), subject: work('Kokoro') },
  ]);
  expect(results(rerun.body)).toEqual([{ key: 'rerun', status: 200, value: { id, revision: 1 } }]);

  const subject = await call('GET', `/v1/subjects/${id}`);
  expect(subject.body.subject.labels).toEqual({ en: 'Kokoro' });
  const revisions = await call('GET', `/v1/subjects/${id}/revisions`);
  expect(revisions.body.revisions.map((revision: Record<string, any>) => revision.source)).toEqual([
    record(externalId),
  ]);
  const authorRevisions = await call('GET', `/v1/subjects/${author.id}/revisions`);
  expect(authorRevisions.body.revisions.map((revision: Record<string, any>) => revision.source)).toEqual(
    expect.arrayContaining([null, record(`${externalId}-author`)]),
  );

  expect(
    (
      await call('POST', `/v1/subjects/${id}:takedown`, {
        token: 'moderator',
        body: { notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' } },
      })
    ).response.status,
  ).toBe(200);
  const gone = await batch([
    { op: 'create', key: 'after-takedown', source: record(externalId), subject: work('Kokoro') },
  ]);
  expect(results(gone.body)).toEqual([{ key: 'after-takedown', status: 404, code: 'not_found' }]);
});

test('a failing command does not stop the batch and a source retracts only its own candidates', async () => {
  const externalId = `OL${randomUUID()}W`;
  const created = await batch([{ op: 'create', key: 'create', source: record(externalId), subject: work('Botchan') }]);
  const id = created.body.results[0].value.id as string;
  const proposed = await batch([
    {
      op: 'propose',
      key: 'language',
      source: record(externalId),
      subject: id,
      statement: cited('schema:inLanguage', 'ja'),
    },
  ]);
  const candidate = proposed.body.results[0].value.candidate as string;

  const mixed = await batch([
    { op: 'propose', key: 'bad', source: record(externalId), subject: id, statement: cited('schema:inLanguage', 42) },
    {
      op: 'propose',
      key: 'unknown',
      source: record(externalId),
      subject: randomUUID(),
      statement: cited('schema:inLanguage', 'ja'),
    },
    {
      op: 'propose',
      key: 'summary',
      source: record(externalId, { field_group: 'summary' }),
      subject: id,
      statement: cited('schema:abstract', {
        language: 'ja',
        document: fromPlainText('親譲りの無鉄砲で小供の時から損ばかりしている。'),
      }),
      rights: {
        license: 'CC-BY-SA-3.0',
        obligations: ['cc:Attribution', 'cc:ShareAlike'],
        attribution: 'Bangumi contributors',
      },
    },
    {
      op: 'propose',
      key: 'language-again',
      source: record(externalId, { record_revision: '2', digest: 'e'.repeat(64) }),
      subject: id,
      statement: cited('schema:inLanguage', 'ja', 'https://openlibrary.org/works/OL1W.json'),
    },
    {
      op: 'retract',
      key: 'other-source',
      source: record(externalId, { source: 'bangumi' }),
      subject: id,
      candidate,
      references: [{ parts: [statement('schema:url', 'https://bgm.tv/subject/1')] }],
    },
    {
      op: 'retract',
      key: 'retract',
      source: record(externalId),
      subject: id,
      candidate,
      references: [{ parts: [statement('schema:url', 'https://openlibrary.org/works/OL1W')] }],
    },
  ]);
  expect(mixed.response.status).toBe(200);
  expect(results(mixed.body)).toEqual([
    { key: 'bad', status: 400, code: 'invalid_request' },
    { key: 'unknown', status: 404, code: 'not_found' },
    { key: 'summary', status: 201, value: { candidate: expect.any(String), revision: 3 } },
    { key: 'language-again', status: 200, value: { candidate, revision: 3 } },
    { key: 'other-source', status: 409, code: 'conflict' },
    { key: 'retract', status: 200, value: { revision: 4 } },
  ]);
  expect(mixed.body.results[0].problem.errors).toContainEqual({
    pointer: '/commands/0/statement/value/content',
    code: 'invalid_type',
  });

  const listing = await call('GET', `/v1/subjects/${id}/candidates?property=schema%3AinLanguage`);
  expect(listing.body.candidates.map((row: Record<string, any>) => [row.id, row.retracted])).toEqual([[candidate, 4]]);
  const again = await batch([
    {
      op: 'propose',
      key: 'after-retract',
      source: record(externalId),
      subject: id,
      statement: cited('schema:inLanguage', 'ja'),
    },
  ]);
  expect(results(again.body)).toEqual([
    { key: 'after-retract', status: 201, value: { candidate: expect.any(String), revision: 5 } },
  ]);
  expect(again.body.results[0].value.candidate).not.toBe(candidate);
});

test('the batch needs its grant, an active release and a well-formed body', async () => {
  const command = { op: 'create', key: 'k', source: record(`OL${randomUUID()}W`), subject: work('Sanshiro') };
  expect((await batch([command], '')).response.status).toBe(401);
  const forbidden = await batch([command], 'editor');
  expect([forbidden.response.status, forbidden.body.code]).toEqual([403, 'forbidden']);
  for (const [body, pointer] of [
    [{}, '/commands'],
    [{ commands: [] }, '/commands'],
    [{ commands: Array.from({ length: 101 }, (_, i) => ({ ...command, key: `k${i}` })) }, '/commands'],
    [{ commands: [command], extra: true }, '/extra'],
  ] as const) {
    const answer = await call('POST', '/v1/subjects:batchWrite', { token: 'importer', body });
    expect([pointer, answer.response.status, answer.body.code]).toEqual([pointer, 400, 'invalid_request']);
    expect(answer.body.errors.map((error: { pointer: string }) => error.pointer)).toContain(pointer);
  }
  const repeated = await batch([command, command]);
  expect(results(repeated.body).map(({ status }) => status)).toEqual([201, 400]);
});
