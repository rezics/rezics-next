import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type Source } from '@rezics/definitions/bulk';
import { checkSubjectInput } from '@rezics/definitions/validate';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000021' };
const actions = ['subject:create', 'subject:read', 'statement:propose'];
const realAccess = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});
beforeAll(async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  await realAccess.grant(global, 'editor', 'subject:create');
  await realAccess.grant(global, 'editor', 'statement:propose');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function post(path: string, body: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        'idempotency-key': `"${randomUUID()}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const reference = { parts: [{ property: { id: 'schema:url' }, value: value('https://example.org/record/1') }] };
const cited = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  references: [reference],
  ...extra,
});
const source: Source = {
  source: 'example',
  external_id: '1',
  record_revision: '1',
  digest: 'b'.repeat(64),
  converter_revision: 'example@1',
  field_group: 'facts',
};
const unprefixed = (prefix: string, violations: { pointer: string; code: string }[]) =>
  violations.map(({ pointer, code }) => ({
    pointer: pointer.startsWith(prefix) ? pointer.slice(prefix.length) : `outside ${pointer}`,
    code,
  }));
const book = (extra: Record<string, unknown>) => ({ type: 'schema:Book', labels: { ja: '吾輩は猫である' }, ...extra });

test('the bulk validator reports exactly what the subject route reports', async () => {
  const inputs = [
    book({ labels: { ja: 'x'.repeat(251) } }),
    book({ statements: { 'schema:nothing': [cited('schema:nothing', 'x')] } }),
    book({
      statements: {
        'schema:datePublished': [
          cited('schema:datePublished', { time: 'soon', precision: 11, calendarmodel: GREGORIAN }),
        ],
      },
    }),
    book({ statements: { 'schema:inLanguage': Array.from({ length: 33 }, () => cited('schema:inLanguage', 'ja')) } }),
    book({ statements: { 'schema:inLanguage': [cited('schema:inLanguage', 'ja', { rank: 'sideways' })] } }),
    book({ extra: true }),
    { type: 'schema:Nothing', labels: { en: 'x' } },
  ];
  for (const subject of inputs) {
    const answer = await post('/v1/subjects', subject);
    expect([answer.response.status, answer.body.code]).toEqual([400, 'invalid_request']);
    expect({ subject, errors: checkSubjectInput(subject, bundledRelease).violations }).toEqual({
      subject,
      errors: answer.body.errors,
    });
  }
});

test('the bulk validator reports exactly what the proposal route reports', async () => {
  const created = await post('/v1/subjects', book({}));
  expect(created.response.status).toBe(201);
  const id = created.body.subject.id as string;
  const inputs = [
    { property: { id: 'schema:inLanguage' }, value: value('ja') },
    cited('schema:inLanguage', 'ja', { references: [] }),
    cited('schema:inLanguage', 'ja', { rank: 'deprecated' }),
    cited('schema:nothing', 'x'),
    cited('schema:inLanguage', 'x'.repeat(1501)),
    cited('schema:inLanguage', 'ja', { references: [{ parts: [] }] }),
  ];
  for (const statement of inputs) {
    const answer = await post(`/v1/subjects/${id}/candidates`, { statement });
    expect([answer.response.status, answer.body.code]).toEqual([400, 'invalid_request']);
    const portable = checkBatchWrite(
      { commands: [{ op: 'propose', key: 'k', source, subject: id, statement }] },
      bundledRelease,
    );
    expect({ statement, errors: unprefixed('/commands/0', portable) }).toEqual({
      statement,
      errors: answer.body.errors,
    });
  }
});

test('decimals and years keep the lengths Wikibase accepts in both validators', async () => {
  const recipe = (amount: string, time = '+2026-10-25T00:00:00Z') => ({
    type: 'schema:Recipe',
    labels: { en: 'Rice' },
    statements: {
      'schema:recipeYield': [cited('schema:recipeYield', { amount, unit: '1' })],
      'schema:datePublished': [cited('schema:datePublished', { time, precision: 11, calendarmodel: GREGORIAN })],
    },
  });
  const decimal = (digits: number) => `+${'9'.repeat(digits)}`;
  expect((await post('/v1/subjects', recipe(decimal(126)))).response.status).toBe(201);
  const cases: [Record<string, unknown>, string][] = [
    [recipe(decimal(127)), '/statements/schema:recipeYield/0/value/content/amount'],
    [recipe('+4', `+${'1'.repeat(17)}-01-01T00:00:00Z`), '/statements/schema:datePublished/0/value/content/time'],
  ];
  for (const [subject, pointer] of cases) {
    const answer = await post('/v1/subjects', subject);
    expect([pointer, answer.response.status, answer.body.errors]).toEqual([
      pointer,
      400,
      [{ pointer, code: 'out_of_range' }],
    ]);
    expect(checkSubjectInput(subject, bundledRelease).violations).toEqual([{ pointer, code: 'out_of_range' }]);
  }
});

test('a bulk create carries no statements', () => {
  const subject = book({ statements: { 'schema:inLanguage': [cited('schema:inLanguage', 'ja')] } });
  const input = { commands: [{ op: 'create', key: 'k', source, subject }] };
  const expected = [{ pointer: '/commands/0/subject/statements', code: 'unsupported' }];
  expect(checkBatchWrite(input)).toEqual(expected);
  expect(checkBatchWrite(input, bundledRelease)).toEqual(expected);
  expect(
    checkBatchWrite({ commands: [{ op: 'create', key: 'k', source, subject: book({}) }] }, bundledRelease),
  ).toEqual([]);
});
