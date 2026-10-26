import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Rights, Source } from '@rezics/definitions/bulk';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const routeKey = new Uint8Array(32).fill(4);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = ['subject:create', 'subject:read', 'subject:batch_write', 'statement:propose'];
const accounts = { importer: newId(0x5100) };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);

function failOneSerializableCommit(target: Pool) {
  let armed = false;
  let failures = 0;
  const wrapped = new Proxy(target, {
    get(poolTarget, property) {
      if (property === 'connect')
        return async () => {
          const client = await poolTarget.connect();
          let serializable = false;
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === 'query') {
                const query = clientTarget.query.bind(clientTarget);
                return (...args: unknown[]) => {
                  const statement =
                    typeof args[0] === 'string'
                      ? args[0]
                      : typeof args[0] === 'object' && args[0] !== null && 'text' in args[0]
                        ? String(args[0].text)
                        : '';
                  if (/^BEGIN ISOLATION LEVEL SERIALIZABLE$/i.test(statement.trim())) serializable = true;
                  if (armed && serializable && statement.trim().toUpperCase() === 'COMMIT') {
                    armed = false;
                    failures++;
                    return query('ROLLBACK').then(() => {
                      throw Object.assign(new Error('Injected serialization failure'), { code: '40001' });
                    });
                  }
                  return query(...(args as Parameters<PoolClient['query']>));
                };
              }
              const value = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            },
          });
        };
      const value = Reflect.get(poolTarget, property, poolTarget);
      return typeof value === 'function' ? value.bind(poolTarget) : value;
    },
  }) as Pool;
  return {
    pool: wrapped,
    arm() {
      armed = true;
    },
    failures() {
      return failures;
    },
  };
}

const commitFailure = failOneSerializableCommit(pool);
const kernel = createKernel({
  pool: commitFailure.pool,
  access: realAccess.access,
  tokens,
  routeKey,
  writeRate: createWriteRateLimiter({ secret: 'imported-summary-retry-test-secret' }),
});

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  for (const action of ACTIONS) await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'importer', action);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function batch(commands: unknown[]) {
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
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const source = (externalId: string, fieldGroup: Source['field_group']): Source => ({
  source: 'openlibrary',
  external_id: externalId,
  record_revision: 'unversioned',
  digest: 'c'.repeat(64),
  converter_revision: 'openlibrary@1',
  field_group: fieldGroup,
});

async function createBook() {
  const externalId = `OL${randomUUID()}W`;
  const answer = await batch([
    {
      op: 'create',
      key: `create-${randomUUID()}`,
      source: source(externalId, 'facts'),
      subject: { type: 'schema:Book', labels: { en: 'Imported summary retry' } },
    },
  ]);
  expect(answer.status).toBe(200);
  expect(answer.body.results[0]).toMatchObject({ status: 201 });
  return answer.body.results[0].value.id as string;
}

const rights: Rights = {
  license: 'CC-BY-SA-3.0',
  obligations: ['cc:Attribution', 'cc:ShareAlike'],
  attribution: 'Open Library contributors',
};

function summary(subject: string, document: unknown, key: string, externalId: string): BatchCommand {
  return {
    op: 'propose',
    key,
    source: source(externalId, 'summary'),
    subject,
    rights,
    statement: {
      property: { id: 'schema:abstract' },
      value: { type: 'value', content: { language: 'ja', document } },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: `https://openlibrary.org/works/${externalId}` },
            },
          ],
        },
      ],
    },
  } as BatchCommand;
}

test('a summary proposal retries after one serialization failure and stores one unchanged summary', async () => {
  const document = fromPlainText('Retrying summaries preserves the imported document.');
  const firstSubject = await createBook();
  const first = await batch([summary(firstSubject, document, `first-${randomUUID()}`, `first-${randomUUID()}`)]);
  const firstResult = first.body.results[0] as Record<string, any>;
  expect(first.status).toBe(200);
  expect(firstResult).toEqual({
    key: expect.any(String),
    status: 201,
    value: { candidate: expect.any(String), revision: 2 },
  });

  const retriedSubject = await createBook();
  commitFailure.arm();
  const retried = await batch([
    summary(retriedSubject, document, `retried-${randomUUID()}`, `retried-${randomUUID()}`),
  ]);
  const retriedResult = retried.body.results[0] as Record<string, any>;
  expect(commitFailure.failures()).toBe(1);
  expect(retried.status).toBe(200);
  expect(retriedResult).toEqual({
    key: expect.any(String),
    status: firstResult.status,
    value: { candidate: expect.any(String), revision: firstResult.value.revision },
  });

  const stored = await pool.query<{
    id: string;
    digest: string;
    statement_content: { language: string; document: string; digest: string };
  }>(
    `SELECT f.id, encode(f.body_sha256, 'hex') AS digest,
            c.statement -> 'value' -> 'content' AS statement_content
     FROM content.imported_field f
     JOIN semantic.candidate c ON c.route = f.route AND c.subject_id = f.subject AND c.candidate_id = f.candidate
     WHERE f.subject = $1`,
    [retriedSubject],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]!.digest).toBe(createHash('sha256').update(serializeDocument(document)).digest('hex'));
  expect(stored.rows[0]!.statement_content).toEqual({
    language: 'ja',
    document: stored.rows[0]!.id,
    digest: stored.rows[0]!.digest,
  });
});

test('a non-snapshot summary document is refused with a document violation and stores nothing', async () => {
  const subject = await createBook();
  for (const document of ['not a snapshot', { profile: 'text', doc: { type: 'doc', content: [] } }]) {
    const answer = await batch([summary(subject, document, `invalid-${randomUUID()}`, `invalid-${randomUUID()}`)]);
    expect(answer.status).toBe(200);
    expect(answer.body.results[0]).toMatchObject({
      status: 400,
      problem: {
        code: 'invalid_request',
        errors: [
          {
            pointer: '/commands/0/statement/value/content/document',
            code: 'invalid_format',
          },
        ],
      },
    });
  }
  const stored = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM content.imported_field WHERE subject = $1',
    [subject],
  );
  expect(stored.rows[0]!.count).toBe(0);
});
