import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Source } from '@rezics/definitions/bulk';
import type { PoolClient, QueryConfig } from 'pg';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { logPendingFenceFailure } from '../../src/semantic/http/bulk.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { importer: Bun.randomUUIDv7() };
const actions = ['subject:create', 'subject:batch_write', 'statement:propose'];
const realAccess = await createRealAccess(admin, accounts, actions);
const routeKey = new Uint8Array(32).fill(4);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const failedType = 'schema:Person';
const failedCause = new TypeError('synthetic command transaction failure');

function failSubjectInsert(client: PoolClient): PoolClient {
  const original = client.query;
  client.query = ((query: QueryConfig | string, ...args: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text;
    const parameters = typeof query === 'string' ? args[0] : query.values;
    if (text.includes('INSERT INTO semantic.subject') && Array.isArray(parameters) && parameters[2] === failedType)
      throw failedCause;
    return Reflect.apply(original, client, [query, ...args]);
  }) as typeof original;
  return client;
}

pool.on('connect', failSubjectInsert);

const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey,
  writeRate: realAccess.writeRate,
  requestDeadlineMs: 10_000,
});

beforeAll(async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of actions) await realAccess.grant(global, 'importer', action);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

const source = (externalId: string): Source => ({
  source: 'openlibrary',
  external_id: externalId,
  record_revision: 'unversioned',
  digest: 'c'.repeat(64),
  converter_revision: 'openlibrary@1',
  field_group: 'facts',
});

test('a command that throws unexpectedly logs one request-scoped line without command values', async () => {
  const externalIds = [randomUUID(), randomUUID()].map((id) => `OL${id}W`);
  const commandKeys = ['good-command', 'private-command-key'];
  const privateLabel = 'private subject value';
  const commands = [
    {
      op: 'create',
      key: commandKeys[0],
      source: source(externalIds[0]!),
      subject: { type: 'schema:Book', labels: { en: 'First subject' } },
    },
    {
      op: 'create',
      key: commandKeys[1],
      source: source(externalIds[1]!),
      subject: { type: failedType, labels: { en: privateLabel } },
    },
  ];
  const lines: unknown[][] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args));
  try {
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/subjects:batchWrite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${realAccess.bearer('importer')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      }),
    );
    const body = (await response.json()) as { results: Record<string, any>[] };

    expect(response.status).toBe(200);
    expect(body.results.map(({ status }) => status)).toEqual([201, 500]);
    expect(body.results[1]).toMatchObject({
      key: commandKeys[1],
      status: 500,
      problem: { code: 'internal_error', request_id: expect.any(String) },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    const raw = lines[0]![0] as string;
    const line = JSON.parse(raw);
    expect(line).toMatchObject({
      event: 'internal_error',
      request_id: body.results[1]!.problem.request_id,
      method: 'POST',
      route: '/v1/subjects:batchWrite',
      name: 'TypeError',
      command_index: 1,
    });
    expect(line.stack).toContain('synthetic command transaction failure');
    expect(raw).not.toMatch(/private-command-key|private subject value|First subject/);
    for (const externalId of externalIds) expect(raw).not.toContain(externalId);
  } finally {
    spy.mockRestore();
  }
});

test('the extracted remaining-fence failure path logs why it answers 500', async () => {
  const requestId = Bun.randomUUIDv7();
  const lines: unknown[][] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args));
  try {
    const cause = logPendingFenceFailure(requestId, 7);
    const response = problemResponse(cause, { method: 'POST', id: requestId, action: 'subject:batch_write' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ code: 'internal_error', request_id: requestId });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    const line = JSON.parse(lines[0]![0] as string);
    expect(line).toMatchObject({
      event: 'internal_error',
      request_id: requestId,
      method: 'POST',
      route: '/v1/subjects:batchWrite',
      name: 'Error',
      command_index: 7,
    });
    expect(line.stack).toContain('Source fence was still pending after the retry pass');
    expect(cause.message).toBe('Source fence was still pending after the retry pass');
  } finally {
    spy.mockRestore();
  }
});
