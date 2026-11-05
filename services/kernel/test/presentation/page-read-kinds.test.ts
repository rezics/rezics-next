import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const routeKey = new Uint8Array(32).fill(7);
const actor = {
  kind: 'account' as const,
  accountId: accounts.editor,
  clientId: 'web',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
let growth: GrowthDatabase;
let pool: Pool;
let admin: Pool;
let realAccess: Awaited<ReturnType<typeof createRealAccess<typeof accounts>>>;
let kernel: ReturnType<typeof createKernel>;

async function call(method: string, path: string, body?: unknown, editor = false) {
  const headers: Record<string, string> = {};
  if (editor) {
    headers.authorization = `Bearer ${realAccess.bearer('editor')}`;
    headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const pageRead = (subject: string) => call('POST', '/v1/pages:read', { target: { subject } });
async function create(type: string, label: string): Promise<string> {
  const idempotencyKey = randomUUID();
  const target = subjectTarget(routeKey, actor.accountId, idempotencyKey);
  const created = await createSubject(pool, {
    actor,
    target,
    idempotencyKey,
    digest: createHash('sha256').update(idempotencyKey).digest(),
    item: { type, labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return created.subject.id;
}
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });

let subject: string;
let holder: string;
let linksGrowthSubject: string;
let collectionsGrowthSubject: string;
let reactionsGrowthSubject: string;
let linkStatement: string;
let profile: PresentationProfile;

beforeAll(async () => {
  growth = await openGrowthDatabase(url);
  pool = growth.pool;
  admin = growth.admin;
  realAccess = await createRealAccess(admin, accounts, ['subject:create']);
  kernel = createKernel({
    pool,
    routeKey,
    access: realAccess.access,
    writeRate: realAccess.writeRate,
    requestDeadlineMs: 30_000,
  });
  await bootstrapRelease(pool, bundledRelease);
  await admin.query(
    `INSERT INTO access.exposure_opening (route,"group",valid,transaction_id)
     VALUES (0,'collections',tstzrange(now()-interval '1 day',NULL,'[)'),$1)`,
    [randomUUID()],
  );
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  subject = await create('schema:Book', 'Page read kinds');
  holder = await create('schema:Person', 'Inverse link holder');
  linksGrowthSubject = await create('schema:Book', 'Links growth subject');
  collectionsGrowthSubject = await create('schema:Book', 'Collections growth subject');
  reactionsGrowthSubject = await create('schema:Book', 'Reactions growth subject');
  linkStatement = randomUUID();
  await admin.query(
    `INSERT INTO semantic.inbound_link
       (route, subject_id, property, source_subject_id, statement_id, source_revision, present,
        recorded_transaction_id, source_type, order_key, filter_value)
     VALUES ($1,$2,'wdt:P725',$3,$4,1,true,$4,'schema:Person','00000001',$2)`,
    [routeOf(subject), subject, holder, linkStatement],
  );
  await admin.query(
    `INSERT INTO semantic.inbound_link_count (route,subject_id,property,filter_value,value)
     VALUES ($1,$2,'wdt:P725',$2,1)`,
    [routeOf(subject), subject],
  );
  profile = {
    format: PROFILE_FORMAT,
    generic: document(node('SubjectHeader', 'header'), node('MoreStatements', 'more')),
    bases: [],
    types: [
      {
        type: 'schema:Book',
        document: document(
          node('SubjectHeader', 'header'),
          node('RelationGroups', 'links', {
            property: 'wdt:P725',
            filter: subject,
            type: 'schema:Person',
            limit: 12,
          }),
          node('CollectionList', 'collections', { title: 'Collections', limit: 6 }),
          node('ReactionSummary', 'reactions'),
        ),
      },
    ],
    routes: [],
  };
  await bootstrapProfile(pool, profile);
});

afterAll(async () => {
  await growth?.close();
});

test.serial(
  'a page read plans and answers an inverse links read by property, filter and type, with its exact or at-least count',
  async () => {
    const answer = await pageRead(subject);
    if (answer.response.status !== 200)
      throw new Error(`Page read failed with ${answer.response.status}: ${JSON.stringify(answer.body)}`);
    expect(answer.body.profile).toBe(profileDigest(profile));
    expect(Object.keys(answer.body.reads).sort()).toEqual(['r0', 'r1', 'r2', 'r3']);

    const standalone = await call(
      'GET',
      `/v1/subjects/${subject}/links?property=wdt%3AP725&filter=${subject}&type=schema%3APerson&limit=12`,
    );
    expect(answer.body.reads.r1).toEqual({ status: standalone.response.status, body: standalone.body });
    expect(answer.body.reads.r1.body.count).toEqual({ value: 1, exact: true });
    expect(answer.body.reads.r1.body.links).toHaveLength(1);
    expect(answer.body.reads.r1.body.links[0]).toMatchObject({
      subject: holder,
      property: 'wdt:P725',
      statement: linkStatement,
      type: 'schema:Person',
      label: 'Inverse link holder',
    });

    await admin.query(
      `UPDATE semantic.inbound_link_count SET value=1001
       WHERE route=$1 AND subject_id=$2 AND property='wdt:P725' AND filter_value=$2`,
      [routeOf(subject), subject],
    );
    const atLeastAnswer = await pageRead(subject);
    const atLeastStandalone = await call(
      'GET',
      `/v1/subjects/${subject}/links?property=wdt%3AP725&filter=${subject}&type=schema%3APerson&limit=12`,
    );
    expect(atLeastAnswer.body.reads.r1).toEqual({
      status: atLeastStandalone.response.status,
      body: atLeastStandalone.body,
    });
    expect(atLeastAnswer.body.reads.r1.body.count).toEqual({ value: 1, exact: false });
  },
);

test.serial("a page read plans and answers the subject's public collections read with its count", async () => {
  const answer = await pageRead(subject);
  expect(answer.response.status).toBe(200);
  const standalone = await call('GET', `/v1/subjects/${subject}/collections?limit=6`);
  expect(answer.body.reads.r2).toEqual({ status: standalone.response.status, body: standalone.body });
  expect(answer.body.reads.r2.body.collections).toEqual([]);
  expect(answer.body.reads.r2.body.count).toEqual({ value: 0, exact: true });
});

test.serial("a page read plans and answers the subject's reaction counts without a viewer's own reaction", async () => {
  const answer = await pageRead(subject);
  expect(answer.response.status).toBe(200);
  const standalone = await call('GET', `/v1/subjects/${subject}/reactions`);
  expect(answer.body.reads.r3).toEqual({ status: standalone.response.status, body: standalone.body });
  expect(answer.body.reads.r3.body).not.toHaveProperty('viewerReaction');
  expect(answer.body.reads.r3.body.counts).toEqual([]);
});

async function requestGrowthRoute(path: string): Promise<Record<string, any>> {
  const { response, body } = await call('GET', path);
  if (response.status !== 200) throw new Error(`GET ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function assertConstantStatements(samples: readonly { cost: { statements: number } }[]): void {
  expect(new Set(samples.map(({ cost }) => cost.statements)).size).toBe(1);
}

test.serial('inverse links read stays within its bound at 1, 10 and 100 holders', async () => {
  const id = linksGrowthSubject;
  const route = routeOf(id)!;
  const report = await checkGrowth(growth, {
    name: 'Inverse links read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      const amount = scale - previous;
      const sources = Array.from({ length: amount }, () => newId(route));
      const statements = Array.from({ length: amount }, () => randomUUID());
      await database.admin.query(
        `INSERT INTO semantic.inbound_link
           (route,subject_id,property,source_subject_id,statement_id,source_revision,present,
            recorded_transaction_id,source_type,order_key,filter_value)
         SELECT $1,$2,'wdt:P725',rows.source_id,rows.statement_id,1,true,rows.source_id,
                'schema:Person',lpad(rows.ordinal::text,8,'0'),$2
         FROM unnest($3::uuid[],$4::uuid[]) WITH ORDINALITY AS rows(source_id,statement_id,ordinal)`,
        [route, id, sources, statements],
      );
      await database.admin.query(
        `INSERT INTO semantic.inbound_link_count (route,subject_id,property,filter_value,value)
         VALUES ($1,$2,'wdt:P725',$2,$3)
         ON CONFLICT (route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
        [route, id, scale],
      );
    },
    async operation(_database, scale) {
      const body = await requestGrowthRoute(
        `/v1/subjects/${id}/links?property=wdt%3AP725&filter=${id}&type=schema%3APerson&limit=12`,
      );
      expect(body.links).toHaveLength(Math.min(scale, 12));
      expect(body.count).toEqual({ value: scale, exact: true });
      return body;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(
    report.samples.every(
      ({ scale, cost }) =>
        (cost.relations['semantic.inbound_link']?.rows ?? 0) <=
        2 * (Math.min(scale, 4 * 12 + 1) + Math.min(scale, 1_000)) + 2,
    ),
  ).toBe(true);
});

test.serial('public collections read stays within its bound at 1, 10 and 100 collections', async () => {
  const id = collectionsGrowthSubject;
  const route = routeOf(id)!;
  const curator = newId(route);
  const report = await checkGrowth(growth, {
    name: 'Public collections read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'linear' },
    async grow(database, scale, previous) {
      const collectionIds = Array.from({ length: scale - previous }, () => newId(route));
      await database.admin.query(
        `INSERT INTO library.collection
           (route,collection_id,curator_account_id,title,visibility,state,revision,member_count,
            order_epoch,created_at,updated_at,transaction_id)
         SELECT $1,collection_id,$2,'Growth collection','public','active',1,0,0,now(),now(),collection_id
         FROM unnest($3::uuid[]) AS rows(collection_id)`,
        [route, curator, collectionIds],
      );
      await database.admin.query(
        `INSERT INTO library.subject_collection
           (route,subject_id,collection_id,collection_route,multiplicity,updated_at,transaction_id)
         SELECT $1,$2,collection_id,$1,1,now(),collection_id
         FROM unnest($3::uuid[]) AS rows(collection_id)`,
        [route, id, collectionIds],
      );
      await database.admin.query(
        `INSERT INTO library.subject_listing (route,subject_id,public_collection_count,revision,updated_at,transaction_id)
         VALUES ($1,$2,$3,1,now(),$2)
         ON CONFLICT (route,subject_id) DO UPDATE SET
           public_collection_count=EXCLUDED.public_collection_count, updated_at=EXCLUDED.updated_at`,
        [route, id, scale],
      );
    },
    async operation(_database, scale) {
      const body = await requestGrowthRoute(`/v1/subjects/${id}/collections?limit=6`);
      expect(body.collections).toHaveLength(Math.min(scale, 6));
      expect(body.count).toEqual({ value: scale, exact: true });
      return body;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  const outputCounts = report.samples.map(({ scale }) => Math.min(scale, 6));
  const statementOverhead = report.samples.map(({ cost }, index) => cost.statements - outputCounts[index]!);
  expect(new Set(statementOverhead).size).toBe(1);
  expect(
    report.samples.every(({ scale, cost }) => {
      const rows = cost.relations['library.subject_collection']?.rows ?? 0;
      return rows <= (scale === 1 ? 1 : scale === 10 ? 10 : 7);
    }),
  ).toBe(true);
  expect(report.samples.every(({ cost }) => (cost.relations['library.collection']?.rows ?? 0) <= 21)).toBe(true);
});

test.serial('reaction counts read stays within its bound at 1, 10 and 100 contributors', async () => {
  const id = reactionsGrowthSubject;
  const route = routeOf(id)!;
  const report = await checkGrowth(growth, {
    name: 'Reaction counts read',
    scales: [1, 10, 100],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await database.admin.query(
        `INSERT INTO content.reaction_count
           (route,target_id,source_partition,kind,count,source_epoch,source_position)
         SELECT $1,$2,partition,'like',1,1,partition
         FROM generate_series($3::integer,$4::integer) AS partition`,
        [route, id, previous + 1, scale],
      );
      await database.admin.query(
        `INSERT INTO content.reaction_total (route,target_id,kind,count,source_epoch,source_position)
         VALUES ($1,$2,'like',$3::integer,1,$4::bigint)
         ON CONFLICT (route,target_id,kind) DO UPDATE SET
           count=EXCLUDED.count, source_position=EXCLUDED.source_position`,
        [route, id, scale, scale],
      );
    },
    async operation(_database, scale) {
      const body = await requestGrowthRoute(`/v1/subjects/${id}/reactions`);
      expect(body.counts).toEqual([{ kind: 'like', count: scale }]);
      expect(body).not.toHaveProperty('viewerReaction');
      return body;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 10, 100]);
  assertConstantStatements(report.samples);
  expect(report.samples.map(({ cost }) => cost.relations['content.reaction_total']?.rows ?? 0)).toEqual([1, 1, 1]);
});
