import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { accessCheck } from '../../src/request/access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { relatedReadEligibility } from '../../src/semantic/eligibility.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createSubject, writeFacts } from '../../src/semantic/subject.ts';
import { readSubjectSummaries, type CoverSummary, type SummaryDependencies } from '../../src/semantic/summaries.ts';
import { expandSlot } from '../../src/semantic/slots.ts';
import { createContext } from '../../src/semantic/context.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import {
  captureUnforcedIndexes,
  logGrowthSeeding,
  unrelatedMediaPopulation,
  unrelatedSemanticPopulation,
} from './planner-graph-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const access = createAccess({ actions: new Map([['subject:read', { anonymous: true }]]) });
const anonymous = { kind: 'anonymous' } as const;
const actor = {
  kind: 'account',
  accountId: newId(0),
  clientId: 'summary-test',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
} as const;
const routeKey = new Uint8Array(32).fill(49);
const credit = {
  rightsHolder: 'Cover Artist',
  via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
  license: 'LicenseRef-unknown',
  obligations: [],
};
const provenance: MediaImportRequest['provenance'] = {
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
const value = (property: string, content: string, language?: string) => ({
  property: { id: property },
  value: { type: 'value', content },
  rank: 'preferred',
  ...(language
    ? { qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: language } }] }
    : {}),
});
const types = (type: string) => [...new Set([type, ...bundledRelease.types[type]!.bases])];

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
});
afterAll(async () => {
  await db?.close();
});

async function subject(
  type: string,
  route: number,
  labels = { en: 'Title' },
  statements: Record<string, unknown[]> = {},
) {
  const id = newId(route);
  const projectedStatements = Object.fromEntries(
    Object.entries(statements).filter(([property]) => property !== 'schema:image'),
  );
  const imageStatements = Object.fromEntries(
    Object.entries(statements).filter(([property]) => property === 'schema:image'),
  );
  const created = await createSubject(db.pool, {
    actor,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type, labels, statements: projectedStatements },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  if (Object.keys(imageStatements).length) {
    const revision = await db.admin.query(
      'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
      [route, id],
    );
    const facts = itemFacts(id, { labels, statements: imageStatements }, type, bundledRelease).filter(
      (fact) => fact.kind === 'statement',
    );
    await writeFacts(db.admin, {
      route,
      subject_id: id,
      transaction_id: revision.rows[0].recorded_transaction_id,
      facts: facts.map((fact) => ({ ...fact, release: bundledDigest })),
    });
  }
  if (Object.keys(projectedStatements).length) {
    const projection = linkProjection(db.pool);
    const partition = partitionOf(route);
    if (partition === null) throw new TypeError('Expected a routed subject fixture');
    for (let step = 0; step < 200; step++) {
      const result = await projection.run(partition);
      if (result.status !== 'busy' && result.envelopes === 0) break;
      if (step === 199) throw new Error('Semantic link projection did not catch up');
    }
  }
  return created.subject.id;
}
async function cover(route: number, container: string) {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance,width,height,thumbhash,average_color,crop,focal_x,focal_y)
    VALUES ($1,$2,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available','m/'||$2::uuid::text||'/original',$6,'https://images.example.test/cover.jpg',$7,$8,1200,1800,decode('AQID','base64'),'#5a4632',ARRAY[10,20,300,500],0.25,0.75)`,
    [route, id, container, actor.accountId, 'a'.repeat(64), newId(route), credit, provenance],
  );
  for (const format of ['avif', 'webp'])
    await db.admin.query(
      `INSERT INTO content.media_variant (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id) VALUES ($1,$2,$3,320,533,$4,1,$5,$6,$7)`,
      [route, id, format, `image/${format}`, 'c'.repeat(64), `m/${id}/${format}-320`, newId(route)],
    );
  return id;
}
function dependencies(client: SummaryDependencies['client'] = db.pool): SummaryDependencies {
  const checks = new Map<string, ReturnType<typeof accessCheck>>();
  return {
    client,
    pool: db.pool,
    release: bundledRelease,
    async authorize(_client, id, batch) {
      const route = routeOf(id)!;
      let pending = checks.get(id);
      if (!pending) {
        pending = accessCheck(
          access,
          anonymous,
          'subject:read',
          { route, id, eligibility: relatedReadEligibility({ route, id }, batch) },
          { pool: db.pool, deadline: Date.now() + 600_000 },
        );
        checks.set(id, pending);
      }
      const check = await pending;
      // Access has its own evidence cost; the growth probe measures the display projection's indexed reads.
      const connection = await db.admin.connect();
      try {
        return await check(connection);
      } finally {
        connection.release();
      }
    },
  };
}
const expectedCover = (media: string): CoverSummary => ({
  media,
  width: 300,
  height: 500,
  placeholder: { thumbhash: 'AQID', color: '#5a4632' },
  variants: [
    { format: 'avif', width: 320 },
    { format: 'webp', width: 320 },
  ],
  focalPoint: { x: 0.25, y: 0.75 },
  credit,
});

let book: string, author: string, edition: string, work: string, english: string, japanese: string;
beforeAll(async () => {
  english = await cover(32000, newId(32000));
  japanese = await cover(32016, newId(32016));
  author = await subject(
    'schema:Person',
    32032,
    { en: 'Author' },
    { 'schema:image': [value('schema:image', english)] },
  );
  edition = await subject(
    'bf:Instance',
    32048,
    { en: 'Edition' },
    { 'schema:image': [value('schema:image', english)] },
  );
  const jaEdition = await subject(
    'bf:Instance',
    32064,
    { en: 'Japanese edition' },
    { 'schema:image': [value('schema:image', japanese)] },
  );
  work = await subject('schema:Book', 32080, { en: 'English title', ja: '日本語の題名' } as { en: string }, {
    'rezics:representativeEdition': [
      value('rezics:representativeEdition', edition, 'en'),
      value('rezics:representativeEdition', jaEdition, 'ja'),
    ],
  });
  book = await subject(
    'bf:Instance',
    32096,
    { en: 'Book' },
    {
      'schema:image': [value('schema:image', english)],
      'schema:author': [value('schema:author', author)],
      'schema:exampleOfWork': [value('schema:exampleOfWork', work)],
    },
  );
});

test("a subject read returns the subject's type, types and cover summary, and the same for every related subject it fills", async () => {
  const kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(12)]]) },
  });
  const response = await kernel.handle(new Request(`http://localhost/v1/subjects/${book}`));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.summary).toEqual({
    id: book,
    type: 'bf:Instance',
    types: types('bf:Instance'),
    label: { value: 'Book', language: 'en' },
    creativeWork: true,
    cover: expectedCover(english),
  });
  expect(body.related[author]).toEqual({
    labels: { en: 'Author' },
    type: 'schema:Person',
    types: types('schema:Person'),
    cover: expectedCover(english),
  });
  const workResponse = await kernel.handle(new Request(`http://localhost/v1/subjects/${work}`));
  const workBody = await workResponse.json();
  expect(workBody.related[edition]).toEqual({
    labels: { en: 'Edition' },
    type: 'bf:Instance',
    types: types('bf:Instance'),
    cover: expectedCover(english),
  });
  const context = await createContext(db.pool, {
    actor,
    target: { route: 32112, id: newId(32112) },
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32),
    input: { labels: { en: 'Community' } },
    authorize: async () => true,
  });
  const contextual = await kernel.handle(
    new Request(`http://localhost/v1/subjects/${book}?context=${context.context.id}`),
  );
  expect(contextual.status).toBe(200);
  expect((await contextual.json()).summary).toEqual(body.summary);
});

test("a work without its own cover shows its representative edition's cover in the title's language", async () => {
  const en = (await readSubjectSummaries(dependencies(), [work], { languages: ['en'] })).get(work)!;
  const ja = (await readSubjectSummaries(dependencies(), [work], { languages: ['ja'] })).get(work)!;
  expect(en.label).toEqual({ value: 'English title', language: 'en' });
  expect(en.cover).toEqual(expectedCover(english));
  expect(ja.label).toEqual({ value: '日本語の題名', language: 'ja' });
  expect(ja.cover).toEqual(expectedCover(japanese));
  const kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(12)]]) },
  });
  const response = await kernel.handle(
    new Request(`http://localhost/v1/subjects/${work}`, {
      headers: { 'accept-language': 'ja-JP, en;q=0.5' },
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).summary).toEqual(ja);
  const fallback = (await readSubjectSummaries(dependencies(), [work], { languages: ['fr'] })).get(work)!;
  expect(fallback).toEqual(en);
});

test('Global representative summaries ignore community projection rows', async () => {
  const title = await subject('schema:Book', 32112, undefined, {
    'rezics:representativeEdition': [value('rezics:representativeEdition', edition, 'en')],
  });
  await db.admin.query('UPDATE semantic.outbound_link SET context_id=$3 WHERE route=$1 AND subject_id=$2', [
    32112,
    title,
    newId(32112),
  ]);
  const summary = (await readSubjectSummaries(dependencies(), [title])).get(title)!;
  expect(summary.cover).toBeNull();
});

test('own preferred images win and representative language fallback is deterministic', async () => {
  const japaneseEdition = await subject('bf:Instance', 32112, undefined, {
    'schema:image': [value('schema:image', japanese)],
  });
  const choices = [
    value('rezics:representativeEdition', japaneseEdition, 'ja'),
    value('rezics:representativeEdition', edition),
  ];
  const unqualified = await subject('schema:Book', 32112, undefined, { 'rezics:representativeEdition': choices });
  const first = await subject('schema:Book', 32112, undefined, { 'rezics:representativeEdition': [choices[0]!] });
  const own = await subject('schema:Book', 32112, undefined, {
    'rezics:representativeEdition': choices,
    'schema:image': [{ ...value('schema:image', english), rank: 'normal' }, value('schema:image', japanese)],
  });
  const result = await readSubjectSummaries(dependencies(), [unqualified, first, own]);
  expect(result.get(unqualified)!.cover).toEqual(expectedCover(english));
  expect(result.get(first)!.cover).toEqual(expectedCover(japanese));
  expect(result.get(own)!.cover).toEqual(expectedCover(japanese));
  const restricted = dependencies();
  const authorize = restricted.authorize;
  restricted.authorize = (client, id, batch) =>
    id === edition ? Promise.resolve(false) : authorize(client, id, batch);
  expect((await readSubjectSummaries(restricted, [unqualified])).get(unqualified)!.cover).toBeNull();
});

test('expanded cover and representative slots use their current Global adoption', async () => {
  const selected = await subject('bf:Instance', 32128, undefined, {
    'schema:image': [value('schema:image', japanese)],
  });
  const title = await subject(
    'schema:Book',
    32128,
    { en: 'Expanded title' },
    { 'rezics:representativeEdition': [value('rezics:representativeEdition', selected, 'en')] },
  );
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    for (const [id, property] of [
      [selected, 'schema:image'],
      [title, 'rezics:representativeEdition'],
    ] as const) {
      const revision = await client.query(
        'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
        [routeOf(id), id],
      );
      await expandSlot(client, id, property, revision.rows[0].recorded_transaction_id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const result = await readSubjectSummaries(dependencies(), [title, selected]);
  expect(result.get(title)!.cover).toEqual(expectedCover(japanese));
  expect(result.get(selected)!.cover).toEqual(expectedCover(japanese));
});

test('a missing, withheld or taken-down cover is null or withheld, never an error', async () => {
  const removed = await cover(32128, newId(32128));
  const removedSubject = await subject('schema:Book', 32144, undefined, {
    'schema:image': [value('schema:image', removed)],
  });
  await db.admin.query(
    'UPDATE content.media SET taken_down=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [32128, removed],
  );
  const missing = await subject('schema:Book', 32160, undefined, {
    'schema:image': [value('schema:image', newId(32160))],
  });
  const empty = await subject('schema:Book', 32176);
  const result = await readSubjectSummaries({ ...dependencies(), maySeeCover: () => false }, [
    book,
    removedSubject,
    missing,
    empty,
  ]);
  for (const id of [book, removedSubject, missing, empty]) expect(result.get(id)!.cover).toBeNull();
  const current = await readSubjectSummaries(dependencies(), [removedSubject, missing, empty]);
  for (const id of [removedSubject, missing, empty]) expect(current.get(id)!.cover).toBeNull();
});

test('a subject summary says whether the subject is a creative work', async () => {
  const result = await readSubjectSummaries(dependencies(), [edition, author]);
  expect(result.get(edition)!.creativeWork).toBe(true);
  expect(result.get(author)!.creativeWork).toBe(false);
});

test('unknown, hidden, taken-down and unreadable subjects have null summaries', async () => {
  const hidden = await subject('schema:Book', 32192);
  const taken = await subject('schema:Book', 32208);
  const unknown = newId(32224);
  await db.admin.query(
    "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
    [32192, hidden],
  );
  await db.admin.query(
    "UPDATE semantic.subject SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
    [32208, taken],
  );
  const result = await readSubjectSummaries(dependencies(), [hidden, taken, unknown, 'invalid']);
  expect([...result.values()]).toEqual([null, null, null, null]);
  const restricted = createAccess({ actions: new Map([['subject:read', { anonymous: false }]]) });
  expect(
    (
      await readSubjectSummaries(
        { pool: db.pool, access: restricted, actor: anonymous, deadline: Date.now() + 60_000 },
        [book],
      )
    ).get(book),
  ).toBeNull();
});

test('summary batches refuse more than 256 ids before SQL', async () => {
  let queried = false;
  const client = {
    query: (() => {
      queried = true;
      throw new Error('SQL must not run');
    }) as SummaryDependencies['client']['query'],
  };
  await expect(
    readSubjectSummaries(
      dependencies(client),
      Array.from({ length: 257 }, () => book),
    ),
  ).rejects.toThrow(RangeError);
  expect(queried).toBe(false);
  expect(await readSubjectSummaries(dependencies(client), [])).toEqual(new Map());
  expect(queried).toBe(false);
});

test('subject summaries for a page use two bounded reads per partition, not one read per subject', async () => {
  const ids: string[] = [];
  const deps = dependencies();
  const unrelated = unrelatedSemanticPopulation(
    'summary-page-unrelated',
    routeOf(edition)! >>> 4,
    [32320, 32336, 32352, 32368].map((route) => route >>> 4),
  );
  const mediaPopulation = unrelatedMediaPopulation('summary-cover-media', routeOf(english)! >>> 4, actor.accountId, {
    credit,
    provenance,
  });
  const operation = async (_db: GrowthDatabase, scale: number) => {
    const summaries = await readSubjectSummaries(deps, ids.slice(0, scale));
    expect(summaries.size).toBe(scale);
    for (const summary of summaries.values()) expect(summary!.cover).toEqual(expectedCover(english));
    return summaries;
  };
  const report = await checkGrowth(db, {
    name: 'subject summary page',
    scales: [4, 32, 256],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
    grow: async (_db, scale, previous) => {
      for (let index = previous; index < scale; index++)
        ids.push(
          await subject('schema:Book', 32320 + (index % 4) * 16, undefined, {
            'rezics:representativeEdition': [value('rezics:representativeEdition', edition)],
          }),
        );
      await seed({ pool: db.pool, admin: db.admin }, unrelated.population, {
        from: previous * 500,
        to: scale * 500,
      });
      await seed(db, mediaPopulation, { from: previous * 500, to: scale * 500 });
      for (const id of ids) await deps.authorize(db.admin, id, ids);
      await deps.authorize(db.admin, edition, [edition]);
    },
    operation,
    warmup: async (_db, scale) => {
      await captureUnforcedIndexes(db, 'subject summary page', scale, () => operation(db, scale), {
        'semantic.subject': 'subject_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
        'semantic.outbound_link': ['outbound_link_present', 'outbound_link_identity'],
        'content.media': ['media_pkey', 'media_cover_reference_idx'],
        'content.media_variant': 'media_variant_pkey',
      });
    },
  });
  logGrowthSeeding(report);
  // costOf excludes SET LOCAL controls, so removing the planner control does not reduce semantic statement totals.
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([11, 11, 11]);
}, 900_000);

test('a representative cover read stays flat as the work gains editions', async () => {
  const deps = dependencies();
  const unrelated = unrelatedSemanticPopulation('representative-cover-unrelated', routeOf(work)! >>> 4, [
    routeOf(edition)! >>> 4,
  ]);
  const mediaPopulation = unrelatedMediaPopulation('summary-cover-media', routeOf(english)! >>> 4, actor.accountId, {
    credit,
    provenance,
  });
  const operation = async () => {
    const result = await readSubjectSummaries(deps, [work]);
    expect(result.get(work)!.cover).toEqual(expectedCover(english));
    return result;
  };
  const report = await checkGrowth(db, {
    name: 'representative edition cover',
    scales: [16, 128, 1024],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale, previous) => {
      for (let index = previous; index < scale; index++)
        await subject('bf:Instance', 32048, undefined, {
          'schema:exampleOfWork': [value('schema:exampleOfWork', work)],
        });
      await seed({ pool: db.pool, admin: db.admin }, unrelated.population, {
        from: previous * 500,
        to: scale * 500,
      });
      await seed(db, mediaPopulation, { from: previous * 500, to: scale * 500 });
      for (const id of [work, edition]) await deps.authorize(db.admin, id, [work, edition]);
    },
    operation,
    warmup: async (_db, scale) => {
      await captureUnforcedIndexes(db, 'representative edition cover', scale, operation, {
        'semantic.subject': 'subject_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
        'semantic.outbound_link': ['outbound_link_present', 'outbound_link_identity'],
        'content.media': ['media_pkey', 'media_cover_reference_idx'],
        'content.media_variant': 'media_variant_pkey',
      });
    },
  });
  logGrowthSeeding(report);
  // costOf excludes SET LOCAL controls, so removing the planner control does not reduce semantic statement totals.
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([5, 5, 5]);
}, 900_000);
