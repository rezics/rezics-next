import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const sourceTokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const ACTIONS = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
];
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000052' };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens: sourceTokens,
  routeKey: new Uint8Array(32).fill(11),
  writeRate: realAccess.writeRate,
});

beforeAll(async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of ACTIONS) {
    if (action !== 'subject:read') await realAccess.grant(global, 'editor', action);
  }
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        ...(body === undefined ? {} : { 'idempotency-key': `"${randomUUID()}"`, 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
async function ok(path: string, body: unknown, status = 200) {
  const answer = await call('POST', path, body);
  expect([answer.response.status, answer.body.code]).toEqual([status, status < 400 ? undefined : 'conflict']);
  return answer.body;
}
const statement = (content: string) => ({
  property: { id: 'schema:inLanguage' },
  value: { type: 'value', content },
});

test('a Global adoption cannot make a subject hold more than 512 current facts', async () => {
  const languages = ['en', 'ja', 'fr', 'de', 'es', 'ko', 'zh-Hans', 'it', 'pt', 'nl', 'ru', 'pl', 'sv', 'fi', 'da'];
  const labels = Object.fromEntries(languages.map((language) => [language, `Name ${language}`]));
  const descriptions = Object.fromEntries(languages.map((language) => [language, `Description ${language}`]));
  const aliases = Object.fromEntries(
    languages.map((language) => [language, Array.from({ length: 32 }, (_, index) => `Alias ${language} ${index}`)]),
  );
  const created = await ok(
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels,
      descriptions,
      aliases,
      statements: { 'schema:inLanguage': [statement('ja'), statement('en')] },
    },
    201,
  );
  const subject = created.subject as Record<string, any>;
  const partition = subjectPartition(subject.id);
  const initial = await admin.query<{ current_facts: number }>(
    'SELECT current_facts FROM semantic.subject WHERE route = $1 AND subject_id = $2',
    [Number.parseInt(subject.id.slice(24, 28), 16), subject.id],
  );
  expect(initial.rows[0]?.current_facts).toBe(512);

  const propose = async (content: string) => {
    const result = await ok(
      `/v1/subjects/${subject.id}/candidates`,
      {
        statement: {
          ...statement(content),
          references: [
            {
              parts: [
                {
                  property: { id: 'schema:url' },
                  value: { type: 'value', content: 'https://example.org/record' },
                },
              ],
            },
          ],
        },
      },
      201,
    );
    const candidate = result.candidate as string;
    await ok(`/v1/subjects/${subject.id}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    return candidate;
  };
  const [first] = (subject.statements['schema:inLanguage'] as { id: string }[]).map(({ id }) => id);
  const candidate1 = await propose('fr');
  const candidate2 = await propose('de');

  const adoption = async (selection: string[], expectedHead: number) =>
    ok(`/v1/subjects/${subject.id}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:inLanguage',
      mode: 'replace',
      selection: selection.map((candidate) => ({ candidate, rank: 'normal' })),
      expected_head: expectedHead,
    });
  await adoption([first!], 1);
  await adoption([first!, candidate1], 2);
  const beforeConflict = await admin.query<{ revision: number; head: number; current_facts: number }>(
    `SELECT (SELECT max(revision) FROM semantic.revision WHERE route = $1 AND subject_id = $2) AS revision,
            (SELECT max(head) FROM semantic.adoption WHERE route = $1 AND subject_id = $2
             AND slot_id = (SELECT slot_id FROM semantic.candidate WHERE route = $1 AND subject_id = $2
                            AND candidate_id = $3 LIMIT 1)
             AND context_id = $4) AS head,
            current_facts
     FROM semantic.subject WHERE route = $1 AND subject_id = $2`,
    [Number.parseInt(subject.id.slice(24, 28), 16), subject.id, candidate2, GLOBAL_CONTEXT],
  );
  expect(beforeConflict.rows[0]).toMatchObject({ revision: 7, head: 3, current_facts: 512 });

  const refused = await call('POST', `/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [first, candidate1, candidate2].map((candidate) => ({ candidate, rank: 'normal' })),
    expected_head: 3,
  });
  expect([refused.response.status, refused.body.code]).toEqual([409, 'conflict']);
  const afterConflict = await admin.query<{ revision: number; head: number; current_facts: number }>(
    `SELECT (SELECT max(revision) FROM semantic.revision WHERE route = $1 AND subject_id = $2) AS revision,
            (SELECT max(head) FROM semantic.adoption WHERE route = $1 AND subject_id = $2
             AND context_id = $3) AS head,
            current_facts
     FROM semantic.subject WHERE route = $1 AND subject_id = $2`,
    [Number.parseInt(subject.id.slice(24, 28), 16), subject.id, GLOBAL_CONTEXT],
  );
  expect(afterConflict.rows[0]).toMatchObject({ revision: 7, head: 3, current_facts: 512 });
  expect(partition).toBe(Number.parseInt(subject.id.slice(24, 28), 16) >>> 4);
});
