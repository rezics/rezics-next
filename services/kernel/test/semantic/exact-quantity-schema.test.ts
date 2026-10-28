import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, validateRelease, valueSchema, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { checkStatementInput, checkSubjectInput } from '@rezics/definitions/validate';
import type { HttpResponse, Persona, Subject } from '../../../../specs/semantic-driver.ts';
import { routeOf } from '../../src/route/route.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

// Explicit extension conformance data, never the bundled measurement/diet release
// or the shared released-discovery fixture. Every operation uses the native driver.
const schema = `id: https://example.org/exact-quantity/conformance
name: quantity_conformance
version: '1'
prefixes:
  linkml: https://w3id.org/linkml/
  ex: https://example.org/exact-quantity/
imports: [linkml:types, rezics]
classes:
  Sample:
    is_a: Thing
    class_uri: ex:Sample
    slots: [exactQuantity, ordinaryQuantity, constrainedQuantity]
    annotations:
      facets: exactQuantity ordinaryQuantity
slots:
  exactQuantity:
    slot_uri: ex:exact
    range: decimal
    multivalued: true
    annotations:
      datatype: quantity
      units: '*'
      exact: true
  ordinaryQuantity:
    slot_uri: ex:ordinary
    range: decimal
    annotations:
      datatype: quantity
      units: '*'
      qualifiers: exactQuantity
  constrainedQuantity:
    slot_uri: ex:constrained
    range: integer
    minimum_value: 0
    maximum_value: 10
    annotations:
      datatype: quantity
      units: '1'
      exact: true
`;
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const references = [{ parts: [snak('schema:url', 'https://example.org/exact-quantity/conformance')] }];
const statement = (content: unknown, id = 'ex:exact') => ({ ...snak(id, content), references });
const input = (entry: unknown, id = 'ex:exact') => ({
  type: 'ex:Sample',
  labels: { en: 'Generic exact quantity conformance' },
  statements: { [id]: [entry] },
});
let driver: SemanticOutcomeDriver;
let release: Release;
let digest: string;
let published: HttpResponse;
let activated: HttpResponse;
let publishKey: ReturnType<typeof key>;
let activateKey: ReturnType<typeof key>;
let activation: { expected_head: number };
let oldInput: object;
let oldCreated: HttpResponse;
let oldKey: ReturnType<typeof key>;

const write = (persona: Persona, path: string, body: unknown, headers = key()) =>
  driver.request(persona, 'POST', path, body, headers);
const get = (path: string) => driver.request('anonymous', 'GET', path);
function bodySubject(response: HttpResponse): Subject {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.subject as Subject;
}
async function create(body: unknown, headers = key(), persona: Persona = 'editor'): Promise<Subject> {
  const response = await write(persona, '/v1/subjects', body, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const subject = response.body.subject as Subject;
  expect(subject.id).toEqual(expect.any(String));
  expect(routeOf(subject.id)).not.toBeNull();
  expect(subject.release).toBe(digest);
  return subject;
}
async function snapshot() {
  // This driver's own isolated native database; no other worker's resources.
  const tables = [
    'semantic.subject',
    'semantic.revision',
    'semantic.fact',
    'semantic.candidate',
    'semantic.source_candidate',
    'semantic.external_claim',
    'semantic.definition_release',
    'semantic.definition_activation',
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
  ];
  return Promise.all(
    tables.map(async (table) => (await driver.fixtures.pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows),
  );
}
function invalid(response: HttpResponse, errors: unknown) {
  expect(response.status, JSON.stringify(response.body)).toBe(400);
  expect(response.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
  expect(response.body.errors).toEqual(errors);
}

beforeAll(async () => {
  driver = await createSemanticDriver();
  const active = await get('/v1/definitions/active');
  expect(active.status).toBe(200);
  expect(active.body.digest).toBe(bundledDigest);
  oldInput = {
    type: 'bf:Instance',
    labels: { en: 'Existing ordinary quantity' },
    statements: {
      'schema:numberOfPages': [
        statement({ amount: '+2', unit: '1', lowerBound: '+1', upperBound: '+3' }, 'schema:numberOfPages'),
      ],
    },
  };
  oldKey = key();
  oldCreated = await write('editor', '/v1/subjects', oldInput, oldKey);
  expect(oldCreated.status, JSON.stringify(oldCreated.body)).toBe(201);
  expect((oldCreated.body.subject as Subject).release).toBe(bundledDigest);
  const compiled = await driver.compile(
    'quantity.yaml',
    { 'quantity.yaml': schema },
    {
      en: {
        types: { 'ex:Sample': 'quantity sample' },
        properties: {
          'ex:exact': 'exact quantity',
          'ex:ordinary': 'ordinary quantity',
          'ex:constrained': 'limited quantity',
        },
      },
    },
  );
  release = compiled.release as unknown as Release;
  digest = compiled.digest;
  expect(validateRelease(release)).toEqual([]);
  expect(digest).not.toBe(bundledDigest);
  expect(release.properties['ex:exact']!.value).toEqual(valueSchema('quantity', { exact: true, units: ['*'] }));
  expect(release.properties['ex:ordinary']!.value).toEqual(valueSchema('quantity', { units: ['*'] }));
  expect(release.properties['ex:exact']).not.toHaveProperty('exact');
  expect(release.types['ex:Sample']!.bases).toContain('schema:Thing');
  publishKey = key();
  published = await write('steward', '/v1/definitions/releases', { release }, publishKey);
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  expect(published.body).toEqual({ digest });
  activateKey = key();
  activation = { expected_head: active.body.head as number };
  activated = await write('steward', `/v1/definitions/releases/${digest}:activate`, activation, activateKey);
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  expect(activated.body).toEqual({ digest, head: activation.expected_head + 1 });
}, 180_000);
afterAll(async () => {
  await driver?.close();
}, 180_000);

test('an explicitly exact quantity rejects both uncertainty bounds through portable and real native validation while ordinary quantity semantics stay unchanged', async () => {
  const exact = { amount: '+2.000100', unit: 'https://units.example/arbitrary' };
  const ordinary = { amount: '-2.500', unit: '1', lowerBound: '-3.000', upperBound: '-2.000' };
  const compact = await create({
    ...input(statement(exact)),
    statements: {
      'ex:exact': [statement(exact)],
      'ex:ordinary': [statement(ordinary, 'ex:ordinary')],
      'ex:constrained': [statement({ amount: '+0', unit: '1' }, 'ex:constrained')],
    },
  });
  const shown = bodySubject(await get(`/v1/subjects/${compact.id}`));
  expect(shown.statements['ex:exact']![0]!.value).toEqual({ type: 'value', content: exact });
  expect(shown.statements['ex:ordinary']![0]!.value).toEqual({ type: 'value', content: ordinary });
  const ordinaryWrite = await write('editor', `/v1/subjects/${compact.id}/candidates`, {
    statement: statement({ amount: '+4', unit: '1', lowerBound: '+3', upperBound: '+5' }, 'ex:ordinary'),
  });
  expect(ordinaryWrite.status, JSON.stringify(ordinaryWrite.body)).toBe(201);
  expect(ordinaryWrite.body.candidate).toEqual(expect.any(String));
  await driver.grant('editor', ['subject:batch_write'], driver.globalContext);
  const source = {
    source: 'example',
    external_id: compact.id,
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: 'example@1',
    field_group: 'facts',
  };
  const beforePublic = bodySubject(await get(`/v1/subjects/${compact.id}`));
  const before = await snapshot();
  const revisions = await driver.inspect.revisions(compact.id);
  for (const bounds of [{ lowerBound: '+2' }, { upperBound: '+2' }, { lowerBound: '+2', upperBound: '+2' }]) {
    const entry = statement({ amount: '+2', unit: '1', ...bounds });
    const errors = Object.keys(bounds).map((bound) => ({
      pointer: `/statement/value/content/${bound}`,
      code: 'unknown_field' as const,
    }));
    expect(checkStatementInput(entry, release).violations).toEqual(errors);
    const subjectErrors = errors.map((error) => ({
      ...error,
      pointer: error.pointer.replace('/statement', '/statements/ex:exact/0'),
    }));
    expect(checkSubjectInput(input(entry), release).violations).toEqual(subjectErrors);
    invalid(await write('editor', '/v1/subjects', input(entry)), subjectErrors);
    invalid(await write('editor', `/v1/subjects/${compact.id}/candidates`, { statement: entry }), errors);
    const commands = [{ op: 'propose', key: randomUUID(), source, subject: compact.id, statement: entry }];
    expect(checkBatchWrite({ commands }, release)).toEqual(
      errors.map((error) => ({ ...error, pointer: `/commands/0${error.pointer}` })),
    );
    const bulk = await write('editor', '/v1/subjects:batchWrite', { commands });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);
    const result = (bulk.body.results as { status: number; problem: Record<string, unknown> }[])[0]!;
    expect(result.status).toBe(400);
    expect(result.problem).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
    expect(result.problem.errors).toEqual(
      errors.map((error) => ({ ...error, pointer: `/commands/0${error.pointer}` })),
    );
    for (const nested of ['qualifiers', 'references']) {
      const parent = statement({ amount: '+2', unit: '1' }, 'ex:ordinary');
      const nestedEntry = {
        ...parent,
        ...(nested === 'qualifiers'
          ? { qualifiers: [snak('ex:exact', entry.value.content)] }
          : { references: [{ parts: [snak('ex:exact', entry.value.content)] }] }),
      };
      const nestedErrors = errors.map((error) => ({
        ...error,
        pointer: error.pointer.replace(
          '/statement',
          nested === 'qualifiers' ? '/statement/qualifiers/0' : '/statement/references/0/parts/0',
        ),
      }));
      expect(checkStatementInput(nestedEntry, release).violations).toEqual(nestedErrors);
      invalid(await write('editor', `/v1/subjects/${compact.id}/candidates`, { statement: nestedEntry }), nestedErrors);
    }
  }
  for (const [content, field, code] of [
    [{ amount: '-1', unit: '1' }, 'amount', 'out_of_range'],
    [{ amount: '+11', unit: '1' }, 'amount', 'out_of_range'],
    [{ amount: '+1.5', unit: '1' }, 'amount', 'invalid_format'],
    [{ amount: '+1', unit: 'https://units.example/arbitrary' }, 'unit', 'invalid_format'],
  ] as const)
    invalid(
      await write('editor', `/v1/subjects/${compact.id}/candidates`, {
        statement: statement(content, 'ex:constrained'),
      }),
      [{ pointer: `/statement/value/content/${field}`, code }],
    );
  invalid(
    await write('editor', `/v1/subjects/${compact.id}/candidates`, {
      statement: statement({ amount: '+2', unit: '1', lowerBound: '+3' }, 'ex:ordinary'),
    }),
    [{ pointer: '/statement/value/content/lowerBound', code: 'out_of_range' }],
  );
  expect(await snapshot()).toEqual(before);
  expect(await driver.inspect.revisions(compact.id)).toEqual(revisions);
  expect(bodySubject(await get(`/v1/subjects/${compact.id}`))).toEqual(beforePublic);
}, 120_000);

test('generic compiled exact quantity uses the same native routes with no vertical handler and preserves arbitrary exact amount strings', async () => {
  // A separately granted native writer keeps the scenarios within the unchanged
  // real account request budgets. Auth, its clock and rate policy stay native.
  await driver.grant('steward', ['subject:create', 'statement:propose'], driver.globalContext);
  for (const amount of [
    '+9007199254740993',
    `+${'9'.repeat(126)}`,
    '-12345678901234567890.000100',
    '+0.00000000000000000001',
  ]) {
    const content = { amount, unit: 'https://units.example/arbitrary' };
    const created = await create(input(statement(content)), key(), 'steward');
    const publicSubject = bodySubject(await get(`/v1/subjects/${created.id}`));
    expect(publicSubject.statements['ex:exact']![0]!).toMatchObject({
      property: { id: 'ex:exact', data_type: 'quantity' },
      value: { type: 'value', content },
      rezics: { release: digest, revision: 1 },
    });
    const stored = await driver.fixtures.pool.query<{ body: { value: unknown } }>(
      "SELECT body FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND property='ex:exact' AND kind='statement'",
      [routeOf(created.id), created.id],
    );
    expect(stored.rows.map((row) => row.body.value)).toEqual([{ type: 'value', content }]);
  }
  for (const type of ['somevalue', 'novalue']) {
    const created = await create(
      input({ property: { id: 'ex:exact' }, value: { type }, references }),
      key(),
      'steward',
    );
    expect(bodySubject(await get(`/v1/subjects/${created.id}`)).statements['ex:exact']![0]!.value as unknown).toEqual({
      type,
    });
  }
  const holder = await create({ type: 'ex:Sample', labels: { en: 'Expanded exact quantity' } }, key(), 'steward');
  const content = { amount: '+9007199254740993.000000000000001', unit: '1' };
  const proposal = { statement: statement(content) };
  const proposalKey = key();
  const path = `/v1/subjects/${holder.id}/candidates`;
  const proposed = await write('steward', path, proposal, proposalKey);
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  expect(candidate).toEqual(expect.any(String));
  const accepted = await write('acceptor', `${path}/${candidate}:accept`, {
    context: driver.globalContext,
    expected_head: null,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const adoptionBody = {
    context: driver.globalContext,
    property: 'ex:exact',
    mode: 'replace',
    selection: [{ candidate, rank: 'preferred' }],
    expected_head: null,
  };
  const adoptionKey = key();
  const adopted = await write('acceptor', `/v1/subjects/${holder.id}:adopt`, adoptionBody, adoptionKey);
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  const shown = bodySubject(await get(`/v1/subjects/${holder.id}`));
  expect(shown.statements['ex:exact']![0]!).toMatchObject({
    id: candidate,
    rank: 'preferred',
    value: { type: 'value', content },
    rezics: { release: digest },
  });
  const before = await snapshot();
  for (const [persona, endpoint, body, headers, original] of [
    ['steward', path, proposal, proposalKey, proposed],
    ['acceptor', `/v1/subjects/${holder.id}:adopt`, adoptionBody, adoptionKey, adopted],
    ['steward', '/v1/definitions/releases', { release }, publishKey, published],
    ['steward', `/v1/definitions/releases/${digest}:activate`, activation, activateKey, activated],
    ['editor', '/v1/subjects', oldInput, oldKey, oldCreated],
  ] as const) {
    const replay = await write(persona, endpoint, body, headers);
    expect(replay.status).toBe(original.status);
    expect(replay.body).toEqual(original.body);
  }
  const conflict = await write(
    'steward',
    path,
    { statement: statement({ ...content, lowerBound: content.amount }) },
    proposalKey,
  );
  expect(conflict.status).toBe(422);
  expect(conflict.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  expect(await snapshot()).toEqual(before);
  expect(bodySubject(await get(`/v1/subjects/${holder.id}`))).toEqual(shown);
  for (const [pin, definition] of [
    [bundledDigest, bundledRelease],
    [digest, release],
  ] as const) {
    const immutable = await get(`/v1/definitions/releases/${pin}`);
    expect(immutable.status).toBe(200);
    expect(immutable.body).toEqual({ digest: pin, release: definition });
    expect(immutable.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(releaseDigest(immutable.body.release as Release)).toBe(pin);
  }
  const old = bodySubject(await get(`/v1/subjects/${(oldCreated.body.subject as Subject).id}`));
  expect(old.statements['schema:numberOfPages']![0]!).toMatchObject({
    value: { type: 'value', content: { amount: '+2', unit: '1', lowerBound: '+1', upperBound: '+3' } },
    rezics: { release: bundledDigest, revision: 1 },
  });
}, 120_000);
