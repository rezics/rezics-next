import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readAuthoredField } from '../../src/content/authored-fields.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { editor: newId(0x5100) };
const actions = ['subject:create', 'subject:read', 'statement:propose', 'moderation:hide', 'subject:batch_write'];
const realAccess = await createRealAccess(admin, accounts, actions);

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
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  for (const action of actions) await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(method: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        'idempotency-key': `"${key}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const content = () => ({
  document: fromPlainText('Simmer gently for thirty minutes.'),
  licence: 'CC-BY-4.0',
  language: 'en',
});
const statement = (property: string, value: unknown) => ({
  property: { id: property },
  value: { type: 'value', content: value },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/recipe' } }] },
  ],
});
const instructions = bundledRelease.types['schema:Recipe']!.properties.includes('schema:recipeInstructions')
  ? 'schema:recipeInstructions'
  : 'schema:abstract';
const recipe = (value: unknown) => ({
  type: 'schema:Recipe',
  labels: { en: 'Stew' },
  statements: { [instructions]: [statement(instructions, value)] },
});
async function book() {
  const answer = await call('POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'A cookbook' } });
  expect(answer.status).toBe(201);
  return answer.body.subject.id as string;
}
async function stored(
  subject: string,
  candidate: string,
  reference: any,
  value: ReturnType<typeof content>,
  revision: number,
) {
  expect(reference).toEqual({
    language: value.language,
    document: expect.any(String),
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(routeOf(reference.document)).toBe(routeOf(subject));
  const row = await readAuthoredField(pool, routeOf(subject)!, reference.document);
  expect(row).toEqual({
    id: reference.document,
    digest: reference.digest,
    subject,
    anchor: null,
    candidate,
    revision,
    authorAccountId: accounts.editor,
    licence: value.licence,
    language: value.language,
    availability: 'available',
    body: Buffer.from(serializeDocument(value.document)),
  });
  expect(await readCandidateDisclosure(pool, { subject, candidate })).toMatchObject({ disclosed: true });
  const events = await admin.query(
    `SELECT data FROM core.outbox WHERE type = 'com.rezics.content.authored-field.created.v1' AND subject = $1`,
    [subject],
  );
  expect(events.rows.map((row) => row.data)).toContainEqual({
    id: reference.document,
    subject,
    candidate,
    authorId: accounts.editor,
  });
}

test('an editor proposes a document value and reads it back', async () => {
  const subject = await book();
  const value = content();
  const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, {
    statement: statement('schema:abstract', value),
  });
  expect(proposed.status).toBe(201);
  const read = await call('GET', `/v1/subjects/${subject}/candidates?property=schema:abstract`);
  expect(read.status).toBe(200);
  const candidate = read.body.candidates.find((entry: any) => entry.id === proposed.body.candidate);
  await stored(subject, candidate.id, candidate.statement.value.content, value, 2);
  const hidden = await call('POST', `/v1/subjects/${subject}/candidates/${candidate.id}:hide`, {
    reason: 'Hidden authored candidate.',
  });
  expect(hidden.status).toBe(200);
  expect(await readCandidateDisclosure(pool, { subject, candidate: candidate.id })).toMatchObject({ disclosed: false });
  const after = await call('GET', `/v1/subjects/${subject}/candidates?property=schema:abstract`);
  expect(after.body.candidates).toEqual([]);
});

test('an editor creates a subject with a document value in one command', async () => {
  const value = content();
  const answer = await call('POST', '/v1/subjects', recipe(value));
  expect(answer.status).toBe(201);
  const subject = answer.body.subject;
  const read = await call('GET', `/v1/subjects/${subject.id}`);
  expect(read.status).toBe(200);
  expect(read.body.subject).toEqual(subject);
  const candidate = subject.statements[instructions][0];
  await stored(subject.id, candidate.id, candidate.value.content, value, 1);
  const rows = await admin.query(
    `SELECT f.xmin = s.xmin AS same_command
    FROM content.authored_field f JOIN semantic.subject s ON s.route = f.route AND s.subject_id = f.subject WHERE f.subject = $1`,
    [subject.id],
  );
  expect(rows.rows).toEqual([{ same_command: true }]);
});

test('a failed document write leaves neither candidate nor document', async () => {
  const subject = await book();
  await admin.query(`CREATE FUNCTION semantic.fail_authored_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM content.authored_field WHERE subject = NEW.subject_id AND candidate = NEW.candidate_id) THEN
        RAISE EXCEPTION 'Forced failure after authored append' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fail_authored_proposal BEFORE INSERT ON semantic.candidate FOR EACH ROW EXECUTE FUNCTION semantic.fail_authored_proposal()`);
  try {
    const answer = await call('POST', `/v1/subjects/${subject}/candidates`, {
      statement: statement('schema:abstract', content()),
    });
    expect(answer.status).toBe(500);
  } finally {
    await admin.query(
      'DROP TRIGGER fail_authored_proposal ON semantic.candidate; DROP FUNCTION semantic.fail_authored_proposal()',
    );
  }
  expect((await admin.query('SELECT 1 FROM semantic.candidate WHERE subject_id = $1', [subject])).rows).toEqual([]);
  expect((await admin.query('SELECT 1 FROM content.authored_field WHERE subject = $1', [subject])).rows).toEqual([]);
  expect((await call('GET', `/v1/subjects/${subject}`)).body.subject.revision).toBe(1);
});

test('media values are still refused in single-subject writes', async () => {
  const subject = await book();
  const media = statement('schema:image', newId(0x5100));
  const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, { statement: media });
  expect(proposed.status).toBe(400);
  expect(proposed.body.errors).toEqual([{ pointer: '/statement/value/content', code: 'unsupported' }]);
  const created = await call('POST', '/v1/subjects', {
    type: 'schema:Book',
    labels: { en: 'Cover' },
    statements: { 'schema:image': [media] },
  });
  expect(created.status).toBe(400);
  expect(created.body.errors).toEqual([{ pointer: '/statements/schema:image/0/value/content', code: 'unsupported' }]);
});

test('an authored create retries one serialization failure without changing its document input', async () => {
  const value = content();
  const input = recipe(value);
  const before = structuredClone(input);
  const key = randomUUID();
  commitFailure.arm();
  const answer = await call('POST', '/v1/subjects', input, key);
  expect(commitFailure.failures()).toBe(1);
  expect(answer.status).toBe(201);
  expect(input).toEqual(before);
  const replay = await call('POST', '/v1/subjects', input, key);
  expect(replay).toEqual(answer);
  const subject = answer.body.subject;
  const candidate = subject.statements[instructions][0];
  await stored(subject.id, candidate.id, candidate.value.content, value, 1);
  expect(
    (await admin.query('SELECT 1 FROM content.authored_field WHERE subject = $1', [subject.id])).rows,
  ).toHaveLength(1);
});

test('authored inputs require a text snapshot, valid licence and BCP 47 language before writing', async () => {
  const subject = await book();
  for (const [member, invalid] of [
    ['document', 'not a snapshot'],
    ['document', {}],
    ['document', { profile: 'text', doc: { type: 'doc', content: [] } }],
    ['licence', 'unknown'],
    ['language', 'en_US'],
  ] as const) {
    const value = { ...content(), [member]: invalid };
    const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, {
      statement: statement('schema:abstract', value),
    });
    expect(proposed.status).toBe(400);
    expect(proposed.body.errors).toEqual([{ pointer: `/statement/value/content/${member}`, code: 'invalid_format' }]);
    const created = await call('POST', '/v1/subjects', recipe(value));
    expect(created.status).toBe(400);
    expect(created.body.errors).toEqual([
      { pointer: `/statements/${instructions}/0/value/content/${member}`, code: 'invalid_format' },
    ]);
  }
  expect((await admin.query('SELECT 1 FROM content.authored_field WHERE subject = $1', [subject])).rows).toEqual([]);
});

test('a bulk facts create still refuses document values without invoking an authored append', async () => {
  const { licence: _, ...importedValue } = content();
  const key = randomUUID();
  const answer = await call('POST', '/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'create',
        key,
        source: {
          source: 'example',
          external_id: key,
          record_revision: '1',
          digest: 'a'.repeat(64),
          converter_revision: 'example@1',
          field_group: 'facts',
        },
        subject: recipe(importedValue),
      },
    ],
  });
  expect(answer.status).toBe(200);
  expect(
    answer.body.results.map((result: any) => ({
      key: result.key,
      status: result.status,
      problem: {
        code: result.problem.code,
        effect_status: result.problem.effect_status,
        errors: result.problem.errors,
      },
    })),
  ).toEqual([
    {
      key,
      status: 400,
      problem: {
        code: 'invalid_request',
        effect_status: 'not_applied',
        errors: [{ pointer: '/commands/0/subject/statements', code: 'unsupported' }],
      },
    },
  ]);
});
