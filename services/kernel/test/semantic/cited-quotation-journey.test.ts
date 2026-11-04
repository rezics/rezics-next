import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { quotationTypeAdmitted } from '../../src/presentation/semantic-page.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000221',
  acceptor: '019a1b2c-3d4e-7f00-8a00-ed170e000222',
  moderator: '019a1b2c-3d4e-7f00-8a00-ed170e000223',
};
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
];
const real = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: real.access,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) },
  routeKey: new Uint8Array(32).fill(42),
  writeRate: real.writeRate,
});
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const sourced = (id: string, content: unknown) => ({
  ...snak(id, content),
  references: [{ parts: [snak('schema:url', 'https://archive.example.test/quotation')] }],
});

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await setupPresentation(pool);
  for (const account of ['editor', 'acceptor', 'moderator'] as const)
    await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(accounts[account]),
      accounts[account],
    ]);
  for (const action of ['subject:create', 'subject:read', 'statement:propose'] as const)
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  for (const action of ['subject:read', 'context:accept', 'context:adopt'] as const)
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', action);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function call(persona: keyof typeof accounts | null, method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${real.bearer(persona)}` } : {}),
        'idempotency-key': `"${randomUUID()}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}
async function create(type: string, name: string, statements: Record<string, unknown> = {}) {
  const answer = await call('editor', 'POST', '/v1/subjects', { type, labels: { en: name }, statements });
  expect(answer.status).toBe(201);
  return answer.body.subject;
}
function pageSubject(page: Record<string, any>) {
  for (const result of Object.values(page.reads ?? {}) as { status?: number; body?: any }[])
    if (result?.status === 200 && result.body?.subject) return result.body;
}
async function readPage(persona: keyof typeof accounts | null, id: string) {
  return call(persona, 'POST', '/v1/pages:read', { target: { subject: id }, languages: ['en'] });
}

test('a sourced quotation keeps exact text, work, speaker and Access-derived correction actions', async () => {
  const work = await create('schema:Book', 'Cited work');
  const speaker = await create('wd:Q95074', 'Hero');
  const credited = await create('schema:Person', 'Credited author');
  const voice = await create('schema:Person', 'Performing voice');
  const text = {
    document: fromPlainText('I will return'),
    language: 'en',
    licence: 'CC-BY-4.0',
  };
  const quotation = await create('schema:Quotation', 'I will return', {
    'schema:text': [sourced('schema:text', text)],
    'schema:spokenByCharacter': [sourced('schema:spokenByCharacter', speaker.id)],
    'schema:about': [sourced('schema:about', work.id)],
    'schema:actor': [sourced('schema:actor', voice.id)],
  });
  const wrong = await call('editor', 'POST', `/v1/subjects/${quotation.id}/candidates`, {
    statement: sourced('schema:spokenByCharacter', work.id),
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'out_of_range' })]));
  const proposed = await call('editor', 'POST', `/v1/subjects/${quotation.id}/candidates`, {
    statement: sourced('schema:creator', credited.id),
  });
  expect(proposed.status).toBe(201);
  const pending = await readPage('editor', quotation.id);
  expect(pageSubject(pending.body).related).not.toHaveProperty(credited.id);
  const accepted = await call(
    'acceptor',
    'POST',
    `/v1/subjects/${quotation.id}/candidates/${proposed.body.candidate}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
  );
  expect(accepted.status).toBe(200);
  const adopted = await call('acceptor', 'POST', `/v1/subjects/${quotation.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:creator',
    mode: 'replace',
    selection: [{ candidate: proposed.body.candidate, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.status).toBe(200);

  const editorPage = await readPage('editor', quotation.id);
  expect(editorPage.status).toBe(200);
  expect(editorPage.headers.get('cache-control')).toContain('no-store');
  expect(editorPage.body.viewer).toEqual({ kind: 'account' });
  expect(editorPage.body.actions).toEqual(
    expect.arrayContaining([
      { action: 'statement:propose', operationId: 'subject.propose', state: 'allowed' },
      { action: 'context:accept', operationId: 'subject.accept_candidate', state: 'denied' },
      { action: 'context:adopt', operationId: 'subject.adopt', state: 'denied' },
    ]),
  );
  const facts = pageSubject(editorPage.body);
  const document = facts.documents[quotation.statements['schema:text'][0].id];
  expect(document.language).toBe('en');
  expect(document.availability).toBe('available');
  expect(facts.related[work.id].labels.en).toBe('Cited work');
  expect(facts.related[speaker.id].labels.en).toBe('Hero');
  expect(facts.related[credited.id].labels.en).toBe('Credited author');
  expect(speaker.id).not.toBe(credited.id);

  const anonymous = await readPage(null, quotation.id);
  expect(anonymous.body.viewer).toEqual({ kind: 'anonymous' });
  expect(anonymous.body.actions).toEqual(
    expect.arrayContaining([{ action: 'statement:propose', operationId: 'subject.propose', state: 'denied' }]),
  );
  const acceptor = await readPage('acceptor', quotation.id);
  expect(acceptor.body.actions).toEqual(
    expect.arrayContaining([
      { action: 'statement:propose', operationId: 'subject.propose', state: 'denied' },
      { action: 'context:accept', operationId: 'subject.accept_candidate', state: 'allowed' },
      { action: 'context:adopt', operationId: 'subject.adopt', state: 'allowed' },
    ]),
  );
  const book = await readPage('editor', work.id);
  expect(book.status).toBe(200);
  expect(book.body).not.toHaveProperty('viewer');
  expect(book.body).not.toHaveProperty('actions');

  const hidden = await call('moderator', 'POST', `/v1/subjects/${speaker.id}:hide`, { reason: 'spoiler' });
  expect(hidden.status).toBe(200);
  const concealed = await readPage('editor', quotation.id);
  expect(pageSubject(concealed.body).related).not.toHaveProperty(speaker.id);
  expect(pageSubject(concealed.body).subject.statements['schema:spokenByCharacter'][0].value.content).toBe(speaker.id);

  const historical = structuredClone(bundledRelease);
  delete historical.types['schema:Quotation'];
  expect(quotationTypeAdmitted(historical, 'schema:Quotation')).toBe(false);
  expect(quotationTypeAdmitted(bundledRelease, 'schema:Quotation')).toBe(true);
});

test('an unreadable speaker stays withheld and a person is not a quotation speaker', async () => {
  const work = await create('schema:Book', 'Withheld work');
  const quotation = await create('schema:Quotation', 'Withheld line', {
    'schema:text': [
      sourced('schema:text', { document: fromPlainText('Hidden line'), language: 'en', licence: 'CC-BY-4.0' }),
    ],
    'schema:spokenByCharacter': [
      {
        property: { id: 'schema:spokenByCharacter' },
        value: { type: 'somevalue' },
        references: [{ parts: [snak('schema:url', 'https://archive.example.test/withheld')] }],
      },
    ],
    'schema:about': [sourced('schema:about', work.id)],
  });
  const page = await readPage('editor', quotation.id);
  expect(page.status).toBe(200);
  const facts = pageSubject(page.body);
  expect(facts.subject.statements['schema:spokenByCharacter'][0].value.type).toBe('somevalue');
  expect(facts.related[work.id].labels.en).toBe('Withheld work');
  const person = await create('schema:Person', 'Not a speaker');
  const rejected = await call('editor', 'POST', '/v1/subjects', {
    type: 'schema:Quotation',
    labels: { en: 'Wrong speaker' },
    statements: {
      'schema:text': [
        sourced('schema:text', { document: fromPlainText('Wrong'), language: 'en', licence: 'CC-BY-4.0' }),
      ],
      'schema:spokenByCharacter': [sourced('schema:spokenByCharacter', person.id)],
    },
  });
  expect(rejected.status).toBe(400);
});
