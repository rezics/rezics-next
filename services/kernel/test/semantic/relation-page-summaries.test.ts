import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { linkProjection, listSubjectLinks } from '../../src/semantic/links.ts';
import { createSubject, writeFacts } from '../../src/semantic/subject.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createRealAccess } from './real-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const readerId = newId(32000);
const access = await createRealAccess(admin, { reader: readerId }, ['subject:read']);
const actor: AccountActor = {
  kind: 'account',
  accountId: readerId,
  clientId: 'relation-page-summaries-test',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(96)]]) },
  routeKey: new Uint8Array(32).fill(97),
  requestDeadlineMs: 30_000,
});
const projection = linkProjection(pool);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(96)]]) };
const contentCredit = {
  rightsHolder: 'Cover Artist',
  via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
  license: 'LicenseRef-unknown',
  obligations: [],
};
const provenance = {
  source: 'catalogue',
  external_id: '42',
  record_revision: '1',
  digest: 'b'.repeat(64),
  converter_revision: '1',
  field_group: 'cover',
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.test/42' } },
      ],
    },
  ],
};
const value = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
  rank: 'preferred',
});

let db: GrowthDatabase;
let coverId: string;
let book: Awaited<ReturnType<typeof create>>;
let unreadableBook: Awaited<ReturnType<typeof create>>;
let instance: Awaited<ReturnType<typeof create>>;
let unreadableInstance: Awaited<ReturnType<typeof create>>;
let unreadableForward: Awaited<ReturnType<typeof create>>;
let pageTarget: Awaited<ReturnType<typeof create>>;
let pageSources: string[];

async function create(
  type: string,
  route: number,
  label: string,
  statements: Record<string, unknown[]> = {},
): Promise<Awaited<ReturnType<typeof createSubject>>['subject']> {
  const id = newId(route);
  const result = await createSubject(db.pool, {
    actor,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: {
      type,
      labels: { en: label, ja: `日本語 ${label}` },
      statements,
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return result.subject;
}

async function createCover(route: number): Promise<string> {
  const media = newId(route);
  await admin.query(
    `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance,width,height,thumbhash,average_color,crop,focal_x,focal_y)
     VALUES ($1,$2,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available','m/'||$2::uuid::text||'/original',$6,'https://images.example.test/cover.jpg',$7,$8,1200,1800,decode('AQID','base64'),'#5a4632',ARRAY[10,20,300,500],0.25,0.75)`,
    [route, media, newId(route), readerId, 'a'.repeat(64), newId(route), contentCredit, provenance],
  );
  for (const format of ['avif', 'webp'])
    await admin.query(
      `INSERT INTO content.media_variant (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
       VALUES ($1,$2,$3,320,533,$4,1,$5,$6,$7)`,
      [route, media, format, `image/${format}`, 'c'.repeat(64), `m/${media}/${format}-320`, newId(route)],
    );
  return media;
}

async function addCover(subject: string, route: number, type: string, label: string, media: string) {
  const revision = await admin.query(
    'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
    [route, subject],
  );
  const facts = itemFacts(
    subject,
    { labels: { en: label }, statements: { 'schema:image': [value('schema:image', media)] } },
    type,
    bundledRelease,
  ).filter((fact) => fact.kind === 'statement');
  await writeFacts(admin, {
    route,
    subject_id: subject,
    transaction_id: revision.rows[0]!.recorded_transaction_id,
    facts: facts.map((fact) => ({ ...fact, release: bundledDigest })),
  });
}

async function catchUp(ids: readonly string[]) {
  const partitions = new Set(
    ids.map((id) => partitionOf(routeOf(id)!)).filter((partition): partition is number => partition !== null),
  );
  for (const partition of partitions) {
    for (let step = 0; step < 200; step++) {
      const result = await projection.run(partition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 199) throw new Error('Semantic link projection did not catch up');
    }
  }
}

async function request(path: string) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      headers: {
        authorization: `Bearer ${access.bearer('reader')}`,
        'accept-language': 'ja, en;q=0.5',
      },
    }),
  );
  return { response, body: (await response.json()) as any };
}

function expectedSummary(id: string, type: string, label: string) {
  const types = [...new Set([type, ...(bundledRelease.types[type]?.bases ?? [])])];
  return {
    id,
    type,
    types,
    label: { value: `日本語 ${label}`, language: 'ja' },
    creativeWork: types.includes('schema:CreativeWork'),
    cover: {
      media: coverId,
      width: 300,
      height: 500,
      placeholder: { thumbhash: 'AQID', color: '#5a4632' },
      variants: [
        { format: 'avif', width: 320 },
        { format: 'webp', width: 320 },
      ],
      focalPoint: { x: 0.25, y: 0.75 },
      credit: contentCredit,
    },
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  coverId = await createCover(32128);
  book = await create('schema:Book', 32144, 'Work');
  unreadableBook = await create('schema:Book', 32160, 'Unreadable work');
  instance = await create('bf:Instance', 32160, 'Edition', {
    'schema:exampleOfWork': [value('schema:exampleOfWork', book.id)],
  });
  unreadableInstance = await create('bf:Instance', 32176, 'Unreadable edition', {
    'schema:exampleOfWork': [value('schema:exampleOfWork', book.id)],
  });
  unreadableForward = await create('bf:Instance', 32192, 'Visible holder with unreadable target', {
    'schema:exampleOfWork': [value('schema:exampleOfWork', unreadableBook.id)],
  });
  pageTarget = await create('schema:Book', 32208, 'Growth target');
  for (const subject of [unreadableBook, unreadableInstance])
    await admin.query(
      "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(subject.id), subject.id],
    );
  await addCover(book.id, 32144, 'schema:Book', 'Work', coverId);
  await addCover(instance.id, 32160, 'bf:Instance', 'Edition', coverId);
  pageSources = [];
  const targetRoutes = [32320, 32336, 32352, 32368];
  for (let index = 0; index < 64; index++) {
    const source = await create('bf:Instance', targetRoutes[index % targetRoutes.length]!, `Summary ${index}`, {
      'schema:exampleOfWork': [value('schema:exampleOfWork', pageTarget.id)],
    });
    pageSources.push(source.id);
  }
  await catchUp([book.id, instance.id, unreadableBook.id, unreadableInstance.id, unreadableForward.id, ...pageSources]);
  for (const id of [book.id, instance.id, unreadableForward.id])
    await access.grant({ route: routeOf(id)!, id }, 'reader', 'subject:read');

  const backgroundSubjects = [32320, 32336, 32352, 32368].flatMap((route) =>
    Array.from({ length: 2_000 }, () => ({ route, subject_id: newId(route) })),
  );
  await admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_release)
     SELECT route,subject_id,'schema:Book',subject_id,$2
     FROM jsonb_to_recordset($1::jsonb) AS seed(route integer,subject_id uuid)`,
    [JSON.stringify(backgroundSubjects), bundledDigest],
  );
});

afterAll(async () => {
  await pool.end();
  await admin.end();
  await db?.close();
});

test('inverse and forward relation pages return the shared display summary and omit unreadable subjects', async () => {
  const inverse = await request(`/v1/subjects/${book.id}/links?property=schema%3AexampleOfWork`);
  expect(inverse.response.status).toBe(200);
  expect(inverse.body.count).toEqual({ value: 2, exact: true });
  expect(inverse.body.links).toEqual([
    {
      subject: instance.id,
      property: 'schema:exampleOfWork',
      statement: instance.statements['schema:exampleOfWork']![0]!.id,
      type: 'bf:Instance',
      label: '日本語 Edition',
      summary: expectedSummary(instance.id, 'bf:Instance', 'Edition'),
    },
  ]);

  const forward = await request(`/v1/subjects/${instance.id}/relations?property=schema%3AexampleOfWork`);
  expect(forward.response.status).toBe(200);
  expect(forward.body.count).toEqual({ value: 1, exact: true });
  expect(forward.body.relations).toHaveLength(1);
  expect(forward.body.relations[0]).toMatchObject({
    target: book.id,
    type: 'schema:Book',
    label: '日本語 Work',
    summary: expectedSummary(book.id, 'schema:Book', 'Work'),
  });

  expect(inverse.body.links.some((link: any) => link.subject === unreadableInstance.id)).toBe(false);
  const unreadable = await request(`/v1/subjects/${unreadableForward.id}/relations?property=schema%3AexampleOfWork`);
  expect(unreadable.response.status).toBe(200);
  expect(unreadable.body.count).toEqual({ value: 1, exact: true });
  expect(unreadable.body.relations).toEqual([]);
  const authorizedIds = new Set(access.readChecks.map((check) => check.resource.id));
  expect(authorizedIds).toContain(instance.id);
  expect(authorizedIds).toContain(book.id);
});

test("a relation page's summaries are bounded by partitions touched", async () => {
  const report = await checkGrowth(db, {
    name: "a relation page's summaries are bounded by partitions touched",
    scales: [4, 16, 64],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
    grow: async () => {},
    operation: async (_database, scale) => {
      let summaryStatements = 0;
      const originalClientQueries = new Map<any, any>();
      const originalConnectMethod = db.pool.connect;
      const originalConnect = originalConnectMethod.bind(db.pool) as (...args: any[]) => any;
      db.pool.connect = ((callback?: (...args: any[]) => void) => {
        const instrument = (client: any) => {
          if (originalClientQueries.has(client)) return client;
          originalClientQueries.set(client, client.query);
          const originalQuery = client.query.bind(client);
          client.query = ((query: any, ...args: any[]) => {
            const text = typeof query === 'string' ? query : query?.text;
            if (typeof text === 'string' && text.includes('original uuid')) summaryStatements++;
            return originalQuery(query, ...args);
          }) as typeof client.query;
          return client;
        };
        if (callback) {
          return originalConnect((error: unknown, client: any, release: (...args: any[]) => void) => {
            callback(error, client ? instrument(client) : client, release);
          });
        }
        return originalConnect().then(instrument);
      }) as typeof db.pool.connect;
      try {
        const page = await listSubjectLinks(db.pool, ring, {
          routeKey: new Uint8Array(32).fill(97),
          subject: pageTarget.id,
          property: 'schema:exampleOfWork',
          limit: scale,
          release: bundledRelease,
          authorize: async () => true,
          authorizeSummary: async () => true,
          seen: [],
          caughtUp: true,
        });
        expect(page.links).toHaveLength(scale);
        expect(summaryStatements).toBe(4);
      } finally {
        db.pool.connect = originalConnectMethod;
        for (const [client, query] of originalClientQueries) client.query = query;
      }
    },
  });
  console.info(
    'Relation summary growth median costs:',
    report.samples.map(({ scale, cost }) => ({
      scale,
      rows: cost.rows,
      blocks: cost.blocks,
      statements: cost.statements,
    })),
  );
  expect(report.samples.map((sample) => sample.scale)).toEqual([4, 16, 64]);
  expect(new Set(pageSources.map((id) => partitionOf(routeOf(id)!))).size).toBe(4);
});
