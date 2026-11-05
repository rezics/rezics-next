import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { createRealAccess } from './real-access.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';
import { readIdentityEpochCutover, runIdentityEpochBootstrapBatch } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 50 });
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001',
  acceptor: '019a1b2c-3d4e-7f00-8a00-acce97000002',
  outsider: '019a1b2c-3d4e-7f00-8a00-0075de000003',
};
const actions = [
  'subject:create',
  'subject:batch_write',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'subject:merge',
  'gate:subject_identity',
];
const realAccess = await createRealAccess(admin, accounts, actions);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:batch_write');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:accept');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'context:adopt');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'subject:merge');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'gate:subject_identity');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'subject:read');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await installIdentityEpochBootstrap(pool);
  // The Community worker closes every native home before serving; repeat its bootstrap batch until the cutover is ready.
  for (let batch = 0; (await withReadTransaction(pool, readIdentityEpochCutover)).state !== 'ready'; batch++) {
    if (batch > 100_000) throw new Error('identity epoch bootstrap did not settle');
    await runIdentityEpochBootstrapBatch(pool);
  }
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

const sessions: Record<string, string> = {};
async function call(method: string, path: string, options: { as?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.as) {
    const credential = Object.hasOwn(accounts, options.as)
      ? realAccess.bearer(options.as as keyof typeof accounts)
      : options.as;
    headers.authorization = `Bearer ${credential}`;
    const session = sessions[options.as];
    if (session) headers['rezics-session-token'] = session;
  }
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (options.as && session) sessions[options.as] = session;
  return { response, body: (await response.json()) as Record<string, any> };
}
const key = () => `"${randomUUID()}"`;
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
const reference = { parts: [statement('schema:url', 'https://www.aozora.gr.jp/cards/000148/card773.html')] };
async function created(body: unknown): Promise<Record<string, any>> {
  const answer = await call('POST', '/v1/subjects', { as: 'editor', key: key(), body });
  expect(answer.response.status).toBe(201);
  return answer.body.subject;
}
const person = (name: string) =>
  created({
    type: 'schema:Person',
    labels: { en: name },
    statements: { 'schema:url': [statement('schema:url', `https://example.org/${randomUUID()}`)] },
  });
const work = (title: string, author: Record<string, any>) =>
  created({
    type: 'schema:Book',
    labels: { en: title },
    statements: { 'schema:author': [statement('schema:author', author.id)] },
  });
const edition = (title: string, workId: string) =>
  created({
    type: 'bf:Instance',
    labels: { en: title },
    statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', workId)] },
  });
const byId = (a: Record<string, any>, b: Record<string, any>) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const linkOf = (source: Record<string, any>, property: string) => ({
  subject: source.id as string,
  property,
  statement: source.statements[property][0].id as string,
});
const sorted = (links: { subject: string }[]) =>
  [...links].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
const fresh = { consistency: 'eventual', target_seconds: 10, caught_up: true };
const merge = (body: unknown, options: { as?: string | null; key?: string } = {}) =>
  call('POST', '/v1/subjects:merge', {
    ...(options.as === null ? {} : { as: options.as ?? 'acceptor' }),
    key: options.key ?? key(),
    body,
  });
async function links(id: string, persona: string) {
  const answer = await call('GET', `/v1/subjects/${id}/links`, { as: persona });
  expect(answer.response.status).toBe(200);
  return answer.body;
}
async function revisions(id: string) {
  const { rows } = await admin.query(
    'SELECT revision, kind, route FROM semantic.revision WHERE subject_id = $1 ORDER BY revision',
    [id],
  );
  return rows;
}

test('a merge redirects the larger id to the smallest with one revision in the redirected partition', async () => {
  const first = await person('Natsume Sōseki');
  const second = await person('Sōseki Natsume');
  const [survivor, redirected] = [first, second].sort(byId) as [Record<string, any>, Record<string, any>];
  const book = await work('Kokoro', redirected);
  const survivorBefore = await revisions(survivor.id);
  const token = key();
  const body = { subjects: [first.id, second.id] };
  const merged = await merge(body, { key: token });
  expect(merged.response.status).toBe(202);
  expect(merged.body).toEqual({ operation: { id: expect.any(String) } });
  expect(merged.response.headers.get('location')).toBe(`/v1/subjectIdentityOperations/${merged.body.operation.id}`);
  expect(realAccess.checks.at(-1)).toEqual({
    persona: 'acceptor',
    action: 'subject:merge',
    resource: { route: 0, id: GLOBAL_CONTEXT },
  });
  const pending = await call('GET', `/v1/subjectIdentityOperations/${merged.body.operation.id}`, { as: 'acceptor' });
  expect(pending.response.status).toBe(200);
  expect(pending.body).toEqual({ operation: { id: merged.body.operation.id, done: false } });
  const redirect = await call('GET', `/v1/subjects/${redirected.id}?context=${GLOBAL_CONTEXT}`);
  expect(redirect.response.status).toBe(308);
  expect(redirect.response.headers.get('location')).toBe(`/v1/subjects/${survivor.id}?context=${GLOBAL_CONTEXT}`);
  expect(redirect.body).toEqual({ redirect: { from: redirected.id, to: survivor.id } });
  const plain = await call('GET', `/v1/subjects/${redirected.id}`);
  expect([plain.response.status, plain.response.headers.get('location')]).toEqual([308, `/v1/subjects/${survivor.id}`]);
  const read = await call('GET', `/v1/subjects/${book.id}`);
  expect(read.body.subject.statements).toEqual(book.statements);
  expect(read.body.related[redirected.id]).toEqual({
    redirect: survivor.id,
    labels: survivor.labels,
    type: 'schema:Person',
    types: ['schema:Person', 'schema:Thing'],
    cover: null,
  });
  expect(await revisions(survivor.id)).toEqual(survivorBefore);
  expect((await revisions(redirected.id)).map((row) => [row.revision, row.kind, row.route])).toEqual([
    [1, 'create', routeOf(redirected.id)],
    [2, 'merge', routeOf(redirected.id)],
  ]);
  const history = await call('GET', `/v1/subjects/${redirected.id}/revisions`);
  expect(history.response.status).toBe(200);
  expect(history.body.revisions.map((row: any) => [row.revision, row.kind])).toEqual([
    [2, 'merge'],
    [1, 'create'],
  ]);
  expect((await merge(body, { key: token })).body).toEqual(merged.body);
  const conflict = await merge({ subjects: [second.id, first.id] }, { key: token });
  expect([conflict.response.status, conflict.body.code]).toEqual([422, 'idempotency_conflict']);
});

test('merges are refused for redirected, identical, mismatched and unknown subjects and write nothing', async () => {
  const people = [await person('Natsume Sōseki'), await person('Sōseki Natsume')].sort(byId);
  const [survivor, redirected] = people as [Record<string, any>, Record<string, any>];
  const third = await person('Natsume Kinnosuke');
  const book = await work('Kokoro', third);
  const proposal = await call('POST', `/v1/subjects/${redirected.id}/candidates`, {
    as: 'editor',
    key: key(),
    body: { statement: { ...statement('schema:url', 'https://www.aozora.gr.jp/'), references: [reference] } },
  });
  expect(proposal.response.status).toBe(201);
  expect((await merge({ subjects: [survivor.id, redirected.id] })).response.status).toBe(202);
  const subjects = [survivor, redirected, third, book];
  const before = await Promise.all(subjects.map((subject) => revisions(subject.id)));
  for (const [pair, status, code] of [
    [[survivor.id, redirected.id], 409, 'conflict'],
    [[redirected.id, third.id], 409, 'conflict'],
    [[survivor.id, survivor.id], 409, 'conflict'],
    [[third.id, book.id], 409, 'conflict'],
    [[third.id, newId(routeOf(third.id)!)], 404, 'not_found'],
    [['01890000-0000-7000-8000-000000000000', third.id], 404, 'not_found'],
  ] as const) {
    const answer = await merge({ subjects: pair });
    expect([pair, answer.response.status, answer.body.code]).toEqual([pair, status, code]);
  }
  for (const body of [{}, { subjects: [third.id] }, { subjects: [third.id, survivor.id, book.id] }]) {
    expect((await merge(body)).response.status).toBe(400);
  }
  const malformed = await merge({ subjects: [third.id, 'not-an-id'] });
  expect(malformed.response.status).toBe(400);
  expect(malformed.body.errors).toContainEqual({ pointer: '/subjects/1', code: 'invalid_format' });
  for (const [as, status, code] of [
    [null, 401, 'authentication_required'],
    ['editor', 403, 'forbidden'],
    ['outsider', 403, 'forbidden'],
  ] as const) {
    const answer = await merge({ subjects: [survivor.id, third.id] }, { as });
    expect([as, answer.response.status, answer.body.code]).toEqual([as, status, code]);
  }
  const candidate = proposal.body.candidate as string;
  const writes = [
    await call('POST', `/v1/subjects/${redirected.id}/candidates`, {
      as: 'editor',
      key: key(),
      body: { statement: { ...statement('schema:url', 'https://www.aozora.gr.jp/'), references: [reference] } },
    }),
    await call('POST', `/v1/subjects/${redirected.id}/candidates/${candidate}:accept`, {
      as: 'acceptor',
      key: key(),
      body: { context: GLOBAL_CONTEXT, expected_head: null },
    }),
    await call('POST', `/v1/subjects/${redirected.id}:adopt`, {
      as: 'acceptor',
      key: key(),
      body: {
        context: GLOBAL_CONTEXT,
        property: 'schema:url',
        mode: 'replace',
        selection: [],
        expected_head: 1,
      },
    }),
  ];
  expect(writes.map((answer) => [answer.response.status, answer.body.code])).toEqual([
    [409, 'conflict'],
    [409, 'conflict'],
    [409, 'conflict'],
  ]);
  const listing = await call('GET', `/v1/subjects/${redirected.id}/candidates?property=schema%3Aurl`);
  expect(listing.response.status).toBe(200);
  expect(listing.body.candidates.map((row: any) => row.id)).toContain(candidate);
  expect(await Promise.all(subjects.map((subject) => revisions(subject.id)))).toEqual(before);
});

test('the survivor gathers the links of the redirected subject, whose own links disappear', async () => {
  const soseki = await person('Natsume Sōseki');
  const works = [await work('Kokoro', soseki), await work('Kokoro (duplicate)', soseki)].sort(byId);
  const [kept, gone] = works as [Record<string, any>, Record<string, any>];
  const keptEdition = await edition('Kokoro, Penguin Classics', kept.id);
  const goneEdition = await edition('Kokoro, Tuttle', gone.id);
  expect((await links(soseki.id, 'editor')).links).toEqual(
    sorted([linkOf(kept, 'schema:author'), linkOf(gone, 'schema:author')]),
  );
  expect((await merge({ subjects: [gone.id, kept.id] })).response.status).toBe(202);
  const later = await edition('Kokoro, Vintage', gone.id);
  expect(later.statements['schema:exampleOfWork'][0].value.content).toBe(gone.id);
  expect(await links(soseki.id, 'acceptor')).toEqual({
    links: [linkOf(kept, 'schema:author')],
    freshness: fresh,
    next: null,
  });
  expect((await links(kept.id, 'acceptor')).links).toEqual(
    expect.arrayContaining([linkOf(keptEdition, 'schema:exampleOfWork'), linkOf(goneEdition, 'schema:exampleOfWork')]),
  );
  expect(await links(kept.id, 'editor')).toEqual({
    links: sorted([keptEdition, goneEdition, later].map((source) => linkOf(source, 'schema:exampleOfWork'))),
    freshness: fresh,
    next: null,
  });
  const redirect = await call('GET', `/v1/subjects/${gone.id}/links?property=schema%3AexampleOfWork`);
  expect(redirect.response.status).toBe(308);
  expect(redirect.response.headers.get('location')).toBe(
    `/v1/subjects/${kept.id}/links?property=schema%3AexampleOfWork`,
  );
  expect((await call('GET', `/v1/subjects/${later.id}`)).body.related[gone.id]).toEqual({
    redirect: kept.id,
    labels: kept.labels,
    type: 'schema:Book',
    types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
    cover: null,
  });
});

test('merging a survivor again repoints every redirect to the final survivor', async () => {
  const people = [await person('Natsume Sōseki'), await person('Sōseki Natsume'), await person('Natsume Kinnosuke')];
  const [smallest, middle, largest] = people.sort(byId) as [
    Record<string, any>,
    Record<string, any>,
    Record<string, any>,
  ];
  const book = await work('Kokoro', largest);
  expect((await links(largest.id, 'editor')).links).toEqual([linkOf(book, 'schema:author')]);
  const firstMerge = await merge({ subjects: [largest.id, middle.id] });
  expect(firstMerge.response.status).toBe(202);
  expect(firstMerge.body).toEqual({ operation: { id: expect.any(String) } });
  const secondMerge = await merge({ subjects: [middle.id, smallest.id] });
  expect(secondMerge.response.status).toBe(202);
  expect(secondMerge.body).toEqual({ operation: { id: expect.any(String) } });
  expect(await links(smallest.id, 'acceptor')).toEqual({
    links: [linkOf(book, 'schema:author')],
    freshness: fresh,
    next: null,
  });
  for (const id of [largest.id, middle.id]) {
    const answer = await call('GET', `/v1/subjects/${id}`);
    expect([id, answer.response.status, answer.response.headers.get('location')]).toEqual([
      id,
      308,
      `/v1/subjects/${smallest.id}`,
    ]);
  }
  expect((await call('GET', `/v1/subjects/${book.id}`)).body.related[largest.id]).toEqual({
    redirect: smallest.id,
    labels: smallest.labels,
    type: 'schema:Person',
    types: ['schema:Person', 'schema:Thing'],
    cover: null,
  });
  expect((await revisions(largest.id)).map((row) => row.kind)).toEqual(['create', 'merge']);
  const refused = await merge({ subjects: [largest.id, smallest.id] });
  expect([refused.response.status, refused.body.code]).toEqual([409, 'conflict']);
});

test('the kernel contract documents merges and redirects', () => {
  const paths = openApiDocument(kernel).paths;
  const operation = paths['/v1/subjects:merge']!.post!;
  expect(operation.operationId).toBe('subject.merge');
  expect(Object.keys(operation.responses!).sort()).toEqual(['202', '400', '401', '403', '404', '409', '422', '503']);
  expect(paths['/v1/subjectIdentityOperations/{id}']!.get!.operationId).toBe('subject_identity_operation.get');
  for (const path of ['/v1/subjects/{id}', '/v1/subjects/{id}/links']) {
    expect([path, Object.keys(paths[path]!.get!.responses!)]).toEqual([path, expect.arrayContaining(['308'])]);
  }
});

test('reviewed original Person GET and native merge preserve ordered evidence, stale refusal and authorized replay', async () => {
  const routeKey = new Uint8Array(32).fill(4);
  const number = String(Date.now());
  const sources = [
    { source: 'bangumi', externalId: `person:${number}` },
    { source: 'vndb', externalId: '' },
  ];
  const partition = partitionOf(tupleRoute(routeKey, sources[0]!.source, sources[0]!.externalId));
  // Derive actual co-resident tuple homes with the installed route key; never fabricate claims/routes.
  for (let i = 1; i <= 100000; i++) {
    const externalId = `s${number}${i}`;
    if (partitionOf(tupleRoute(routeKey, 'vndb', externalId)) === partition) {
      sources[1]!.externalId = externalId;
      break;
    }
  }
  expect(sources[1]!.externalId).not.toBe('');
  const properties = ['wdt:P6298', 'wdt:P3180'];
  const values = [number, sources[1]!.externalId];
  const batch = await call('POST', '/v1/subjects:batchWrite', {
    as: 'editor',
    body: {
      commands: sources.map((source, index) => ({
        op: 'create',
        key: randomUUID(),
        source: {
          source: source.source,
          external_id: source.externalId,
          record_revision: '1',
          digest: 'c'.repeat(64),
          converter_revision: 'review@1',
          field_group: 'facts',
        },
        subject: {
          type: 'schema:Person',
          labels: { en: 'Reviewed Person' },
          statements: { [properties[index]!]: [statement(properties[index]!, values[index])] },
        },
      })),
    },
  });
  expect(batch.response.status).toBe(200);
  expect(batch.body.results.map((result: any) => result.status)).toEqual([201, 201]);
  const subjects = batch.body.results.map((result: any) => result.value.id) as [string, string];
  const query = (index: number) =>
    new URLSearchParams({
      reviewIdentitySource: sources[index]!.source,
      reviewIdentityExternalId: sources[index]!.externalId,
      includeViewerActions: 'true',
    });
  const reads = await Promise.all(subjects.map((id, index) => call('GET', `/v1/subjects/${id}?${query(index)}`)));
  for (const [index, read] of reads.entries()) {
    expect(read.response.status).toBe(200);
    expect(read.response.headers.get('cache-control')).toBe('private, no-store');
    expect(read.body.reviewedIdentity).toEqual({
      subject: subjects[index],
      revision: 1,
      securityRevision: expect.stringMatching(/^[1-9][0-9]*$/),
      ...sources[index],
      property: properties[index],
      value: values[index],
      claimTransactionId: expect.any(String),
    });
  }
  for (const suffix of [
    'reviewIdentitySource=bangumi',
    'reviewIdentityExternalId=person:1',
    'reviewIdentitySource=bangumi&reviewIdentityExternalId=person:01',
  ])
    expect((await call('GET', `/v1/subjects/${subjects[0]}?${suffix}`)).response.status).toBe(400);
  const missing = await call(
    'GET',
    `/v1/subjects/${subjects[0]}?reviewIdentitySource=bangumi&reviewIdentityExternalId=person:1`,
  );
  expect(missing.body.reviewedIdentity).toBeNull();
  const body = { subjects, expectedIdentity: { endpoints: reads.map((read) => read.body.reviewedIdentity) } };
  const before = await Promise.all(subjects.map(revisions));
  for (const field of ['revision', 'securityRevision', 'claimTransactionId'] as const) {
    const stale = structuredClone(body);
    stale.expectedIdentity.endpoints[0][field] =
      field === 'revision' ? 2 : field === 'securityRevision' ? '9999999999999999999' : randomUUID();
    expect((await merge(stale)).response.status).toBe(409);
  }
  const swapped = structuredClone(body);
  swapped.expectedIdentity.endpoints.reverse();
  expect((await merge(swapped)).response.status).toBe(400);
  const extra = structuredClone(body);
  extra.expectedIdentity.endpoints[0].grant = true;
  expect((await merge(extra)).response.status).toBe(400);
  expect(await Promise.all(subjects.map(revisions))).toEqual(before);
  const token = key();
  const result = await merge(body, { key: token });
  expect(result.response.status).toBe(202);
  expect(result.body).toEqual({ operation: { id: expect.any(String) } });
  expect(result.response.headers.get('location')).toBe(`/v1/subjectIdentityOperations/${result.body.operation.id}`);
  expect((await merge(body, { key: token })).body).toEqual(result.body);
  expect((await merge({ subjects }, { key: token })).response.status).toBe(422);
  const changed = structuredClone(body);
  changed.expectedIdentity.endpoints[0].revision++;
  expect((await merge(changed, { key: token })).response.status).toBe(422);
  const [, redirectedId] = [...subjects].sort();
  const redirectedIndex = subjects.indexOf(redirectedId!);
  const redirected = await call('GET', `/v1/subjects/${subjects[redirectedIndex]}?${query(redirectedIndex)}`);
  expect(redirected.response.status).toBe(308);
  expect(redirected.body.reviewedIdentity).toBeUndefined();
  const poll = await call('GET', `/v1/subjectIdentityOperations/${result.body.operation.id}`, { as: 'acceptor' });
  expect(poll.response.status).toBe(200);
  expect(poll.body.operation.id).toBe(result.body.operation.id);
  expect(poll.body.operation.done).toBe(false);
  await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'subject:merge');
  try {
    expect((await merge(body, { key: token })).response.status).toBe(403);
    const deniedPoll = await call('GET', `/v1/subjectIdentityOperations/${result.body.operation.id}`, {
      as: 'acceptor',
    });
    expect(deniedPoll.response.status).toBe(404);
  } finally {
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', 'subject:merge');
  }
});

test('reviewed Person merge refuses absent claims, wrong types, malformed selection and writes nothing', async () => {
  const people = [await person('One'), await person('Two')];
  const book = await work('Kokoro', people[0]!);
  const before = await Promise.all([...people, book].map((subject) => revisions(subject.id)));
  const absent = await merge({
    subjects: [people[0]!.id, people[1]!.id],
    expectedIdentity: {
      endpoints: [
        {
          subject: people[0]!.id,
          revision: 1,
          securityRevision: '1',
          source: 'bangumi',
          externalId: 'person:1',
          claimTransactionId: randomUUID(),
          property: 'wdt:P6298',
          value: '1',
        },
        {
          subject: people[1]!.id,
          revision: 1,
          securityRevision: '1',
          source: 'vndb',
          externalId: 's1',
          claimTransactionId: randomUUID(),
          property: 'wdt:P3180',
          value: 's1',
        },
      ],
    },
  });
  expect([absent.response.status, absent.body.code]).toEqual([409, 'conflict']);
  const wrongType = await merge({ subjects: [people[0]!.id, book.id] });
  expect([wrongType.response.status, wrongType.body.code]).toEqual([409, 'conflict']);
  const malformed = await merge({
    subjects: [people[0]!.id, people[1]!.id],
    expectedIdentity: { endpoints: [{ subject: people[0]!.id }, { subject: people[1]!.id }] },
  });
  expect(malformed.response.status).toBe(400);
  expect(await Promise.all([...people, book].map((subject) => revisions(subject.id)))).toEqual(before);
});

test('a held subject lock times out competing merge and leaves no effect until release', async () => {
  const people = [await person('Lock A'), await person('Lock B')].sort(byId) as [
    Record<string, any>,
    Record<string, any>,
  ];
  const held = await admin.connect();
  let open = true;
  try {
    await held.query('BEGIN');
    await held.query('SET LOCAL lock_timeout = 200');
    await held.query('SELECT subject_id FROM semantic.subject WHERE subject_id = $1 FOR UPDATE', [people[1]!.id]);
    const started = Date.now();
    const blocked = await merge({ subjects: [people[0]!.id, people[1]!.id] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(blocked.response.status).toBe(503);
    expect(await revisions(people[1]!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1 })]));
    await held.query('ROLLBACK');
    open = false;
    expect((await merge({ subjects: [people[0]!.id, people[1]!.id] })).response.status).toBe(202);
    expect((await revisions(people[1]!.id)).map((row) => row.kind)).toEqual(['create', 'merge']);
  } finally {
    if (open) await held.query('ROLLBACK');
    held.release();
  }
});
