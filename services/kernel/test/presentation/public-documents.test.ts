import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, checkDocument, serializeDocument } from '@rezics/document';
import { MAX_PAGE_DOCUMENTS, planReads, platformRegistry } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { createApp } from '../../src/http/app.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import { MAX_PAGE_READS, PageReadBudget, PageReadError, readPage } from '../../src/presentation/reads.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

setDefaultTimeout(120_000);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(38)]]) };
const accounts = { author: newId(0xc841) };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'document:erase',
  'moderation:hide',
  'subject:batch_write',
];
let db: GrowthDatabase;
let real: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let app: ReturnType<typeof createKernel>;
const property = 'schema:recipeInstructions';
const english = fromPlainText('Rinse rice.\nSimmer for 25 minutes.');
const japanese = fromPlainText('米を洗う。');
const cited = (id: string, document: unknown, language = 'en') => ({
  property: { id },
  value: { type: 'value', content: { document, language, licence: 'CC-BY-4.0' } },
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/original' } }] },
  ],
});

async function call(method: string, path: string, body?: unknown, author = false, session?: string) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(author ? { authorization: `Bearer ${real.bearer('author')}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { [SESSION_HEADER]: session } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: response.status === 204 ? null : await response.json() };
}
async function created(
  statements: Record<string, ReturnType<typeof cited>[]> = { [property]: [cited(property, english)] },
) {
  const result = await call(
    'POST',
    '/v1/subjects',
    { type: 'schema:Recipe', labels: { en: 'Public rice' }, statements },
    true,
  );
  expect(result.response.status).toBe(201);
  return result.body.subject;
}
async function acceptAndAdopt(subject: string, candidate: string, rank: 'preferred' | 'normal') {
  expect(
    (
      await call(
        'POST',
        `/v1/subjects/${subject}/candidates/${candidate}:accept`,
        { context: GLOBAL_CONTEXT, expected_head: null },
        true,
      )
    ).response.status,
  ).toBe(200);
  expect(
    (
      await call(
        'POST',
        `/v1/subjects/${subject}:adopt`,
        {
          context: GLOBAL_CONTEXT,
          property,
          mode: 'replace',
          expected_head: null,
          selection: [{ candidate, rank }],
        },
        true,
      )
    ).response.status,
  ).toBe(200);
}
async function aggregate(id: string, language = 'en', author = false, session?: string) {
  return call('POST', '/v1/pages:read', { target: { subject: id }, languages: [language] }, author, session);
}
function subjectRead(page: any, id: string) {
  const plan = planReads(platformRegistry, page.document, { subject: id });
  const key = Object.entries(plan.reads).find(([, read]) => read.kind === 'subject' && read.id === id)![0];
  expect(page.reads[key].status).toBe(200);
  return page.reads[key].body;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1; // Dependent owners must release their connection before the next native read.
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, platformProfile);
  real = await createRealAccess(db.admin, accounts, actions);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'author', action);
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(39),
    tokens,
    access: real.access,
    writeRate: real.writeRate,
  });
});
afterAll(async () => {
  await db?.close();
});

test('one aggregate shares the disclosed subject and fills exactly the standalone document.get representation and session', async () => {
  const subject = await created();
  const statement = subject.statements[property][0];
  const reference = statement.value.content;
  const standalone = await call('GET', `/v1/documents/${reference.document}`);
  expect(standalone.response.status).toBe(200);
  const page = await aggregate(subject.id, 'en', false, standalone.response.headers.get(SESSION_HEADER)!);
  expect(page.response.status).toBe(200);
  expect(page.response.headers.get('cache-control')).toBe('private, no-store');
  const filled = subjectRead(page.body, subject.id);
  expect(filled.subject.statements[property][0].value.content).toEqual(reference);
  expect(filled.documents).toEqual({ [statement.id]: standalone.body.document });
  expect(checkDocument(filled.documents[statement.id].body)).toBe(true);
  expect(filled.documents[statement.id]).toEqual({
    id: reference.document,
    candidateId: statement.id,
    subjectId: subject.id,
    revision: 1,
    origin: 'account',
    author: accounts.author,
    licence: 'CC-BY-4.0',
    language: 'en',
    digest: createHash('sha256').update(serializeDocument(english)).digest('hex'),
    availability: 'available',
    body: english,
  });
  const scope = 'anonymous';
  const merged = decodeSession(tokens, scope, page.response.headers.get(SESSION_HEADER)!)!;
  for (const anchor of decodeSession(tokens, scope, standalone.response.headers.get(SESSION_HEADER)!)!)
    expect(merged).toContainEqual(anchor);
});

test('rank and selected language come from the disclosed observation, including an actual accepted and adopted document', async () => {
  const subject = await created({
    'schema:abstract': [cited('schema:abstract', english), cited('schema:abstract', japanese, 'ja')],
  });
  const proposed = await call(
    'POST',
    `/v1/subjects/${subject.id}/candidates`,
    { statement: cited(property, english) },
    true,
  );
  expect(proposed.response.status).toBe(201);
  const candidate = proposed.body.candidate;
  await acceptAndAdopt(subject.id, candidate, 'preferred');
  const page = await aggregate(subject.id, 'ja');
  expect(page.response.status).toBe(200);
  const filled = subjectRead(page.body, subject.id);
  expect(Object.values(filled.documents).map((document: any) => document.body)).toEqual(
    expect.arrayContaining([english, japanese]),
  );
  expect(Object.values(filled.documents)).toHaveLength(2);
  const englishAbstract = subject.statements['schema:abstract'].find((row: any) => row.value.content.language === 'en');
  expect(filled.documents[englishAbstract.id]).toBeUndefined();
  const adopted = filled.subject.statements[property][0];
  const standalone = await call('GET', `/v1/documents/${adopted.value.content.document}`);
  expect(standalone.response.status).toBe(200);
  expect(filled.documents[candidate]).toEqual(standalone.body.document);
});

for (const lifecycle of ['erase', 'withhold'] as const) {
  test(`${lifecycle} is rechecked by the native owner even after an earlier successful aggregate`, async () => {
    const subject = await created();
    const statement = subject.statements[property][0];
    const reference = statement.value.content;
    const before = await aggregate(subject.id, 'en', true);
    expect(before.response.status).toBe(200);
    expect(subjectRead(before.body, subject.id).documents[statement.id].body).toEqual(english);
    const path =
      lifecycle === 'erase'
        ? `/v1/documents/${reference.document}`
        : `/v1/subjects/${subject.id}/candidates/${statement.id}:hide`;
    const changed = await call(
      lifecycle === 'erase' ? 'DELETE' : 'POST',
      path,
      lifecycle === 'withhold' ? { reason: 'Withheld publication.' } : undefined,
      true,
    );
    expect(changed.response.status).toBe(lifecycle === 'erase' ? 204 : 200);
    const independent = await call('GET', `/v1/documents/${reference.document}`, undefined, true);
    expect(independent.response.status).toBe(404);
    const after = await aggregate(subject.id, 'en', true);
    expect(after.response.status).toBe(200);
    expect(after.response.headers.get('cache-control')).toBe('private, no-store');
    expect(subjectRead(after.body, subject.id).documents).toEqual({});
    const anonymous = await aggregate(subject.id);
    expect(anonymous.response.status).toBe(200);
    expect(subjectRead(anonymous.body, subject.id).documents).toEqual({});
    expect(JSON.stringify(anonymous.body)).not.toContain('Simmer for 25 minutes.');
  });
}

test('withdrawing the selected value leaves a readable candidate out of the aggregate', async () => {
  const subject = await created();
  const candidate = subject.statements[property][0];
  expect(subjectRead((await aggregate(subject.id)).body, subject.id).documents[candidate.id].body).toEqual(english);
  const withdrawn = await call(
    'POST',
    `/v1/subjects/${subject.id}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property,
      mode: 'replace',
      selection: [],
      expected_head: 1,
    },
    true,
  );
  expect(withdrawn.response.status).toBe(200);
  // Independent readability never makes an unselected candidate part of this page.
  expect((await call('GET', `/v1/documents/${candidate.value.content.document}`)).response.status).toBe(200);
  const page = await aggregate(subject.id);
  expect(page.response.status).toBe(200);
  expect(subjectRead(page.body, subject.id).documents).toEqual({});
});

test('a native source retraction removes its adopted document from the configured public representation', async () => {
  const subject = await created({});
  const source = {
    source: 'example',
    external_id: randomUUID(),
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: 'v1',
    field_group: 'summary',
  };
  const statement = cited(property, english);
  const proposed = await call(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'propose',
          key: randomUUID(),
          source,
          subject: subject.id,
          statement: { ...statement, value: { type: 'value', content: { document: english, language: 'en' } } },
          rights: { license: 'CC-BY-4.0', obligations: ['cc:Attribution'], attribution: 'Original author' },
        },
      ],
    },
    true,
  );
  expect(proposed.response.status).toBe(200);
  expect(proposed.body.results[0].status).toBe(201);
  const candidate = proposed.body.results[0].value.candidate;
  await acceptAndAdopt(subject.id, candidate, 'normal');
  const before = await aggregate(subject.id);
  expect(before.response.status).toBe(200);
  const document = subjectRead(before.body, subject.id).documents[candidate];
  const independent = await call('GET', `/v1/documents/${document.id}`);
  expect(independent.response.status).toBe(200);
  expect(document).toEqual(independent.body.document);
  const retracted = await call(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'retract',
          key: randomUUID(),
          source: { ...source, record_revision: '2' },
          subject: subject.id,
          candidate,
          references: statement.references,
        },
      ],
    },
    true,
  );
  expect(retracted.response.status).toBe(200);
  expect(retracted.body.results[0].status).toBe(200);
  const after = await aggregate(subject.id);
  expect(after.response.status).toBe(200);
  expect(subjectRead(after.body, subject.id).documents).toEqual({});
  expect(JSON.stringify(after.body)).not.toContain('Simmer for 25 minutes.');
});

test('an unreadable subject prevents both independent document and aggregate disclosure', async () => {
  const subject = await created();
  const candidate = subject.statements[property][0];
  expect((await aggregate(subject.id)).response.status).toBe(200);
  expect(
    (await call('POST', `/v1/subjects/${subject.id}:hide`, { reason: 'Publication withdrawn.' }, true)).response.status,
  ).toBe(200);
  const independent = await call('GET', `/v1/documents/${candidate.value.content.document}`);
  expect(independent.response.status).toBe(404);
  const page = await aggregate(subject.id);
  expect(page.response.status).toBe(404);
  expect(page.response.headers.get('cache-control')).toBe('private, no-store');
  expect(JSON.stringify(page.body)).not.toContain('Simmer for 25 minutes.');
});

test('native document.get cannot be rebound to a different subject, candidate, digest or language', async () => {
  const subject = await created();
  const other = await created();
  const actual = await call('GET', `/v1/subjects/${subject.id}`);
  expect(actual.response.status).toBe(200);
  const candidate = actual.body.subject.statements[property][0];
  for (const mismatch of ['subject', 'candidate', 'digest', 'language'] as const) {
    const observation = structuredClone(actual.body);
    const id = mismatch === 'subject' ? other.id : subject.id;
    observation.subject.id = id;
    const row = observation.subject.statements[property][0];
    if (mismatch === 'candidate') row.id = newId(0xc841);
    if (mismatch === 'digest') row.value.content.digest = '0'.repeat(64);
    if (mismatch === 'language') row.value.content.language = 'ja';
    // A stale/misbound scheduling observation cannot override the actual standalone owner response.
    const result = await readPage({
      dispatch: (request) => app.handle(request),
      incoming: new Request('http://kernel.test/v1/pages:read'),
      reads: { subject: { kind: 'subject', id } },
      session: { ring: tokens, scope: 'anonymous' },
      documents: { kind: 'documents', id, properties: [property] },
      languages: ['en'],
      observed: new Map([[canonicalize({ kind: 'subject', id })!, { status: 200, body: observation }]]),
      budget: Object.assign(new PageReadBudget(), { reads: 1, cost: 1 }),
    });
    expect(result.documents).toEqual({});
  }
  expect(candidate.value.content.document).toBeDefined();
});

test('the effective dependent plan charges all native slots and refuses overflow before document I/O', async () => {
  const subject = await created();
  const observed = await call('GET', `/v1/subjects/${subject.id}`);
  expect(observed.response.status).toBe(200);
  const route = routeOf(subject.id)!;
  const properties = Array.from({ length: MAX_PAGE_DOCUMENTS + 1 }, (_, index) => `schema:p${index}`);
  const observation = structuredClone(observed.body);
  observation.subject.statements = Object.fromEntries(
    properties.map((id) => [
      id,
      [
        {
          id: newId(route),
          rank: 'normal',
          property: { id, data_type: 'document' },
          value: {
            type: 'value',
            content: { document: newId(route), digest: 'a'.repeat(64), language: 'en' },
          },
        },
      ],
    ]),
  );
  const calls: string[] = [];
  await expect(
    readPage({
      dispatch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return app.handle(request);
      },
      incoming: new Request('http://kernel.test/v1/pages:read'),
      reads: { subject: { kind: 'subject', id: subject.id } },
      documents: { kind: 'documents', id: subject.id, properties },
      session: { ring: tokens, scope: 'anonymous' },
      observed: new Map([[canonicalize({ kind: 'subject', id: subject.id })!, { status: 200, body: observation }]]),
    }),
  ).rejects.toMatchObject({ errors: [{ pointer: '/reads', code: 'out_of_range' }] });
  expect(calls).toEqual([]);
  const remaining = Object.assign(new PageReadBudget(), { reads: MAX_PAGE_READS - 1, cost: MAX_PAGE_READS - 1 });
  calls.length = 0;
  await expect(
    readPage({
      dispatch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return app.handle(request);
      },
      incoming: new Request('http://kernel.test/v1/pages:read'),
      reads: { subject: { kind: 'subject', id: subject.id } },
      documents: { kind: 'documents', id: subject.id, properties: [property] },
      session: { ring: tokens, scope: 'anonymous' },
      budget: remaining,
    }),
  ).rejects.toBeInstanceOf(PageReadError);
  expect(calls).toEqual([`/v1/subjects/${subject.id}`]);
});

test('fixed public bodies keep native request, SQL, Access and byte bounds at unrelated histories 64/512/4096', async () => {
  const subject = await created();
  const document = subject.statements[property][0].value.content;
  const bodyBytes = Buffer.from(serializeDocument(english));
  const subjectPartition = partitionOf(routeOf(subject.id)!);
  let counts = { requests: 0, access: 0, bytes: 0 };
  const report = await checkGrowth(db, {
    name: 'configured page document bodies',
    rule: 'series',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    counted: { read: () => counts, bounds: { requests: 'constant', access: 'constant', bytes: 'constant' } },
    async grow(target, scale, previous) {
      // Unrelated storage is growth noise, never a permission fixture or a returned document.
      await seed(
        target,
        {
          name: 'unrelated page document history',
          hotPartition: subjectPartition,
          hotShare: 1,
          rows: ({ route }) => {
            const id = newId(route);
            const unrelated = newId(route);
            const candidate = newId(route);
            const transaction = newId(route);
            return {
              'semantic.subject': [
                { route, subject_id: unrelated, type: 'schema:Recipe', recorded_transaction_id: transaction },
              ],
              'semantic.revision': [
                {
                  route,
                  subject_id: unrelated,
                  revision: 1,
                  kind: 'propose',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                },
              ],
              'semantic.candidate': [
                {
                  route,
                  subject_id: unrelated,
                  candidate_id: candidate,
                  slot_id: candidate,
                  property,
                  rank: 'normal',
                  statement: {},
                  release: bundledDigest,
                  revision: 1,
                  origin: 'proposal',
                },
              ],
              'content.authored_field': [
                {
                  route,
                  id,
                  subject: unrelated,
                  candidate,
                  revision: 1,
                  author_account_id: accounts.author,
                  body: bodyBytes,
                  body_sha256: Buffer.from(document.digest, 'hex'),
                  licence: 'CC-BY-4.0',
                  language: 'en',
                  availability: 'available',
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      const checks = real.readChecks.length;
      let requests = 0;
      const result = await readPage({
        dispatch: async (request) => {
          requests++;
          return app.handle(request);
        },
        incoming: new Request('http://kernel.test/v1/pages:read'),
        reads: { subject: { kind: 'subject', id: subject.id } },
        documents: { kind: 'documents', id: subject.id, properties: [property] },
        session: { ring: tokens, scope: 'anonymous' },
      });
      expect(result.results.subject!.status).toBe(200);
      expect(Object.values(result.documents).map((row: any) => row.body)).toEqual([english]);
      counts = {
        requests,
        access: real.readChecks.length - checks,
        bytes: Buffer.byteLength(JSON.stringify(result.documents)),
      };
      expect(requests).toBe(2);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});

test('shared subject aliases and document references incur one native operation each, including the total requested cost', async () => {
  const subject = await created();
  const budget = new PageReadBudget();
  const calls: string[] = [];
  const options = {
    dispatch: async (request: Request) => {
      calls.push(new URL(request.url).pathname);
      return app.handle(request);
    },
    incoming: new Request('http://kernel.test/v1/pages:read'),
    reads: {
      header: { kind: 'subject' as const, id: subject.id },
      statements: { kind: 'subject' as const, id: subject.id },
    },
    documents: { kind: 'documents' as const, id: subject.id, properties: [property, property] },
    session: { ring: tokens, scope: 'anonymous' },
    budget,
  };
  const page = await readPage(options);
  expect(page.results.header).toEqual(page.results.statements);
  expect(Object.values(page.documents).map((document: any) => document.body)).toEqual([english]);
  expect(calls).toEqual([
    `/v1/subjects/${subject.id}`,
    `/v1/documents/${subject.statements[property][0].value.content.document}`,
  ]);
  expect({ reads: budget.reads, cost: budget.cost }).toEqual({ reads: 2, cost: 2 });
  calls.length = 0;
  const full = Object.assign(new PageReadBudget(), { reads: 0, cost: 127 });
  await expect(readPage({ ...options, budget: full })).rejects.toBeInstanceOf(PageReadError);
  expect(calls).toEqual([`/v1/subjects/${subject.id}`]);
  expect(full.cost).toBe(128);
});

test('in-process native dispatch retains the aggregate request deadline', async () => {
  const deadline = Date.now() + 10_000;
  const native = createApp({ pool: db.pool }).get('/deadline', ({ job }) => ({ deadline: job.deadline }));
  const response = await withRequestDeadline(deadline, () => native.handle(new Request('http://kernel.test/deadline')));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deadline });
});
