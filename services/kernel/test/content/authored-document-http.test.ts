import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { createRealAccess } from '../semantic/real-access.ts';

setDefaultTimeout(120_000);

const route = 0xc120;
const routeKey = new Uint8Array(32).fill(11);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(12)]]) };
const author = newId(0xc230);
const other = newId(0xc231);
const moderator = newId(0xc232);
const actions = ['subject:create', 'subject:read', 'statement:propose', 'moderation:hide', 'document:erase'] as const;
const document = fromPlainText('Simmer gently for thirty minutes.');
const licence = 'CC-BY-4.0';
const language = 'en';
const property = 'schema:abstract';
let db: GrowthDatabase;
let realAccess: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let app: ReturnType<typeof createKernel>;
const accounts = { author, other, moderator };

function request(method: string, path: string, account?: keyof typeof accounts, key = randomUUID(), body?: unknown) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(account ? { authorization: `Bearer ${realAccess.bearer(account)}` } : {}),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function writeAuthoredDocument(label: string) {
  const value = { document, licence, language };
  const response = await request('POST', '/v1/subjects', 'author', randomUUID(), {
    type: 'schema:Recipe',
    labels: { en: label },
    statements: {
      [property]: [
        {
          property: { id: property },
          value: { type: 'value', content: value },
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/recipe' } },
              ],
            },
          ],
        },
      ],
    },
  });
  const body = (await response.json()) as {
    subject: {
      id: string;
      revision: number;
      statements: Record<string, { id: string; value: { content: { document: string; digest: string } } }[]>;
    };
  };
  expect(response.status).toBe(201);
  const subject = body.subject;
  const candidate = subject.statements[property]![0]!;
  await realAccess.grant({ route: routeOf(subject.id)!, id: subject.id }, 'author', 'subject:read');
  return {
    id: candidate.value.content.document,
    subject: subject.id,
    candidate: candidate.id,
    revision: subject.revision,
    digest: candidate.value.content.digest,
    author,
  };
}

async function insertImportedDocument() {
  const id = newId(route);
  const subject = newId(route);
  const candidate = newId(route);
  const bytes = Buffer.from(serializeDocument(document));
  const digest = createHash('sha256').update(bytes).digest();
  await db.admin.query(
    `INSERT INTO content.imported_field(route,id,subject,candidate,revision,body,body_sha256,source,rights,language,availability)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,'en','available')`,
    [
      route,
      id,
      subject,
      candidate,
      bytes,
      digest,
      {
        source: 'example',
        external_id: 'authored-document-http-import',
        record_revision: '1',
        digest: 'a'.repeat(64),
        converter_revision: 'v1',
        field_group: 'summary',
        references: [],
      },
      { license: 'CC-BY-4.0', obligations: ['cc:Attribution'], attribution: 'Example' },
    ],
  );
  return id;
}

function problemShape(body: Record<string, unknown>) {
  return { ...body, request_id: null };
}

async function unknownDocument() {
  const response = await request('GET', `/v1/documents/${newId(route)}`);
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status).toBe(404);
  return { response, body };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  realAccess = await createRealAccess(db.admin, accounts, actions);
  for (const action of ['subject:create', 'statement:propose'])
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'author', action);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
  app = createKernel({
    pool: db.pool,
    routeKey,
    access: realAccess.access,
    tokens,
    writeRate: realAccess.writeRate,
  });
});

afterAll(async () => {
  await db?.close();
});

test('authored document read returns its account origin, author and licence while the candidate is disclosed', async () => {
  const field = await writeAuthoredDocument('Authored recipe');
  const response = await request('GET', `/v1/documents/${field.id}`, 'author');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    document: {
      id: field.id,
      subjectId: field.subject,
      candidateId: field.candidate,
      revision: field.revision,
      origin: 'account',
      author: field.author,
      licence,
      language,
      digest: field.digest,
      availability: 'available',
      body: document,
    },
  });
});

test('undisclosed and retracted candidates, unreadable subjects and erased documents match an unknown id', async () => {
  const unknown = await unknownDocument();
  const hidden = await writeAuthoredDocument('Hidden recipe');
  const hiddenCandidate = await request(
    'POST',
    `/v1/subjects/${hidden.subject}/candidates/${hidden.candidate}:hide`,
    'moderator',
    randomUUID(),
    { reason: 'Hidden for the authored document test.' },
  );
  expect(hiddenCandidate.status).toBe(200);
  const hiddenRead = await request('GET', `/v1/documents/${hidden.id}`, 'author');
  expect(hiddenRead.status).toBe(404);
  expect(problemShape((await hiddenRead.json()) as Record<string, unknown>)).toEqual(problemShape(unknown.body));

  const retracted = await writeAuthoredDocument('Retracted recipe');
  const retractedRoute = routeOf(retracted.subject)!;
  const transaction = newId(retractedRoute);
  await db.admin.query(
    `WITH candidate AS (
       SELECT slot_id FROM semantic.fact
       WHERE route=$1 AND subject_id=$2 AND statement_id=$3 AND kind='statement' AND operation='assert'
       LIMIT 1
     ), next_log AS (
       SELECT coalesce(max(log_seq),0)+1 AS log_seq FROM semantic.fact WHERE route=$1 AND subject_id=$2
     )
     INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,property,statement_id,body,recorded_transaction_id)
     SELECT $1,$2,candidate.slot_id,next_log.log_seq,'retract','statement',$4,$3,'{}'::jsonb,$5
     FROM candidate CROSS JOIN next_log`,
    [retractedRoute, retracted.subject, retracted.candidate, property, transaction],
  );
  const retractedRead = await request('GET', `/v1/documents/${retracted.id}`, 'author');
  expect(retractedRead.status).toBe(404);
  expect(problemShape((await retractedRead.json()) as Record<string, unknown>)).toEqual(problemShape(unknown.body));

  const unreadable = await writeAuthoredDocument('Unreadable recipe');
  await db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'subject:read','resource','(,)',$3)`,
    [routeOf(unreadable.subject), unreadable.subject, other],
  );
  const unreadableRead = await request('GET', `/v1/documents/${unreadable.id}`, 'other');
  expect(unreadableRead.status).toBe(404);
  expect(problemShape((await unreadableRead.json()) as Record<string, unknown>)).toEqual(problemShape(unknown.body));
  await db.admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    routeOf(unreadable.subject),
    unreadable.subject,
    other,
  ]);

  const erased = await writeAuthoredDocument('Erased recipe');
  const deletion = await request('DELETE', `/v1/documents/${erased.id}`, 'author');
  expect(deletion.status).toBe(204);
  const erasedRead = await request('GET', `/v1/documents/${erased.id}`, 'author');
  expect(erasedRead.status).toBe(404);
  expect(problemShape((await erasedRead.json()) as Record<string, unknown>)).toEqual(problemShape(unknown.body));
});

test('DELETE lets only the author erase an authored document and replays with the original session position', async () => {
  const field = await writeAuthoredDocument('Deletion recipe');
  const key = randomUUID();
  const first = await request('DELETE', `/v1/documents/${field.id}`, 'author', key);
  expect(first.status).toBe(204);
  expect(await first.text()).toBe('');
  expect(first.headers.get(SESSION_HEADER)).not.toBeNull();

  const partition = partitionOf(routeOf(field.id)!);
  const position = (
    await db.admin.query('SELECT position::text FROM core.partition WHERE partition_no=$1', [partition])
  ).rows[0];
  const replay = await request('DELETE', `/v1/documents/${field.id}`, 'author', key);
  expect(replay.status).toBe(204);
  expect(await replay.text()).toBe('');
  expect(replay.headers.get(SESSION_HEADER)).toBe(first.headers.get(SESSION_HEADER));
  expect(
    (await db.admin.query('SELECT position::text FROM core.partition WHERE partition_no=$1', [partition])).rows[0],
  ).toEqual(position);

  const refused = await request('DELETE', `/v1/documents/${field.id}`, 'other');
  expect(refused.status).toBe(404);
  expect((await refused.json()).code).toBe('not_found');

  const importedId = await insertImportedDocument();
  const importedDelete = await request('DELETE', `/v1/documents/${importedId}`, 'author');
  expect(importedDelete.status).toBe(404);
  expect(
    (
      await db.admin.query('SELECT availability FROM content.imported_field WHERE route=$1 AND id=$2', [
        route,
        importedId,
      ])
    ).rows[0],
  ).toEqual({ availability: 'available' });
});

test('authored document read', async () => {
  const ids: { id: string }[] = [];
  const bytes = Buffer.from(serializeDocument(document));
  const digest = createHash('sha256').update(bytes).digest();
  const population = (remember: boolean): Population => ({
    name: 'authored document reads in one partition',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ route: itemRoute }) => {
      const subject = newId(itemRoute);
      const candidate = newId(itemRoute);
      const id = newId(itemRoute);
      const transaction = newId(itemRoute);
      if (remember) ids.push({ id });
      return {
        'semantic.subject': [
          { route: itemRoute, subject_id: subject, type: 'schema:Recipe', recorded_transaction_id: transaction },
        ],
        'semantic.revision': [
          {
            route: itemRoute,
            subject_id: subject,
            revision: 1,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.candidate': [
          {
            route: itemRoute,
            subject_id: subject,
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
            route: itemRoute,
            id,
            subject,
            candidate,
            revision: 1,
            author_account_id: author,
            body: bytes,
            body_sha256: digest,
            licence,
            language,
            availability: 'available',
          },
        ],
      };
    },
  });
  // Include both document storage and its semantic disclosure keys at the first
  // sample; background identities never replace the sampled document shape.
  await seed(db, population(false), { from: 0, to: 2048 });
  const report = await checkGrowth(db, {
    name: 'authored document read',
    rule: 'series',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(target, scale, previous) {
      await seed(target, population(true), { from: previous, to: scale });
    },
    async operation(_target, scale) {
      const response = await request('GET', `/v1/documents/${ids[scale - 1]!.id}`);
      expect(response.status).toBe(200);
      expect((await response.json()).document.origin).toBe('account');
    },
  });
  expect(ids).toHaveLength(4096);
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) expect(sample.cost.statements).toBeGreaterThan(0);
});
