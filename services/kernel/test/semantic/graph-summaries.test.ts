import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { expandSlot } from '../../src/semantic/slots.ts';
import { createSubject, writeFacts } from '../../src/semantic/subject.ts';
import type { CoverSummary, SubjectSummary } from '../../src/semantic/summaries.ts';
import { capture, costOf, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const actor = {
  kind: 'account',
  accountId: newId(0),
  clientId: 'graph-summary-test',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
} as const;
const denied = new Set<string>();
const checked = new Set<string>();
const credit = {
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
  references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: credit.via.url } }] }],
};
const value = (property: string, content: string, language?: string) => ({
  property: { id: property },
  value: { type: 'value', content },
  rank: 'preferred',
  ...(language
    ? { qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: language } }] }
    : {}),
});
let kernel: ReturnType<typeof createKernel>;
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  kernel = createKernel({
    pool: db.pool,
    access(config) {
      const real = createAccess(config);
      return deriveAccess(real, {
        async authorize(client, reader, action, resource, evidence, time) {
          if (action === 'subject:read') checked.add(resource.id);
          return (await real.authorize(client, reader, action, resource, evidence, time)) && !denied.has(resource.id);
        },
      });
    },
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(81)]]) },
    routeKey: new Uint8Array(32).fill(82),
    requestDeadlineMs: 600_000,
  });
});
afterAll(async () => {
  await db?.close();
});

async function subject(
  type: string,
  route: number,
  labels: Record<string, string> = { en: 'Title' },
  statements: Record<string, unknown[]> = {},
) {
  const id = newId(route);
  const created = await createSubject(db.pool, {
    actor,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: {
      type,
      labels,
      statements: Object.fromEntries(Object.entries(statements).filter(([property]) => property !== 'schema:image')),
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  if (statements['schema:image']) {
    const revision = await db.admin.query(
      'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
      [route, id],
    );
    const facts = itemFacts(
      id,
      { labels, statements: { 'schema:image': statements['schema:image'] } },
      type,
      bundledRelease,
    ).filter((fact) => fact.kind === 'statement');
    await writeFacts(db.admin, {
      route,
      subject_id: id,
      transaction_id: revision.rows[0].recorded_transaction_id,
      facts: facts.map((fact) => ({ ...fact, release: bundledDigest })),
    });
  }
  return created.subject.id;
}

async function cover(route: number) {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance,width,height,thumbhash,average_color,crop,focal_x,focal_y)
     VALUES ($1,$2,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available','m/'||$2::uuid::text||'/original',$6,'https://images.example.test/cover.jpg',$7,$8,1200,1800,decode('AQID','base64'),'#5a4632',ARRAY[10,20,300,500],0.25,0.75)`,
    [route, id, newId(route), actor.accountId, 'a'.repeat(64), newId(route), credit, provenance],
  );
  for (const format of ['avif', 'webp'])
    await db.admin.query(
      `INSERT INTO content.media_variant (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
       VALUES ($1,$2,$3,320,533,$4,1,$5,$6,$7)`,
      [route, id, format, `image/${format}`, 'c'.repeat(64), `m/${id}/${format}-320`, newId(route)],
    );
  return id;
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
function summary(
  id: string,
  type: string,
  label: SubjectSummary['label'],
  cover: CoverSummary | null = null,
): SubjectSummary {
  const types = [...new Set([type, ...bundledRelease.types[type]!.bases])];
  return { id, type, types, label, creativeWork: types.includes('schema:CreativeWork'), cover };
}
async function catchUp() {
  const projection = linkProjection(db.pool);
  const partitions = await db.admin.query('SELECT DISTINCT route / 16 AS partition FROM semantic.subject');
  for (const { partition } of partitions.rows) {
    for (let step = 0; step < 2_000; step++) {
      const result = await projection.run(Number(partition));
      if (result.status === 'busy') continue;
      if (result.envelopes === 0) break;
      if (step === 1_999) throw new Error('Semantic link projection did not catch up');
    }
  }
}
async function get(path: string, language = 'en') {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, { headers: { 'accept-language': language } }),
  );
  const body = (await response.json()) as any;
  expect({ status: response.status, ...(response.status === 200 ? {} : { body }) }).toEqual({ status: 200 });
  return body;
}
function graphPath(id: string, properties = ['rezics:sameSetting'], limit = 25) {
  const query = new URLSearchParams({ direction: 'out', depth: '2', limit: String(limit) });
  for (const property of properties) query.append('property', property);
  return `/v1/subjects/${id}/graph?${query}`;
}

test('graph nodes carry the shared current display summary', async () => {
  const enCover = await cover(32000);
  const jaCover = await cover(32016);
  const en = await subject(
    'bf:Instance',
    32032,
    { en: 'English edition' },
    { 'schema:image': [value('schema:image', enCover)] },
  );
  const ja = await subject(
    'bf:Instance',
    32048,
    { en: 'Japanese edition' },
    { 'schema:image': [value('schema:image', jaCover)] },
  );
  const author = await subject(
    'schema:Person',
    32064,
    { en: 'Author' },
    { 'schema:image': [value('schema:image', enCover)] },
  );
  const book = await subject(
    'schema:Book',
    32096,
    { en: 'English title', ja: '日本語の題名' },
    {
      'schema:inLanguage': [value('schema:inLanguage', 'ja')],
      'schema:author': [value('schema:author', author)],
      'rezics:representativeEdition': [
        value('rezics:representativeEdition', en, 'en'),
        value('rezics:representativeEdition', ja, 'ja'),
      ],
    },
  );
  await catchUp();
  for (const [languages, language, label, media] of [
    ['fr, en;q=0.8, ja;q=0.5', 'en', 'English title', enCover],
    ['fr', 'ja', '日本語の題名', jaCover],
    ['ja, en;q=0.5', 'ja', '日本語の題名', jaCover],
  ]) {
    const graph = await get(graphPath(book, ['schema:author']), languages);
    expect(graph.nodes[0]).toEqual({
      id: book,
      type: 'schema:Book',
      label,
      summary: summary(book!, 'schema:Book', { value: label!, language: language! }, expectedCover(media!)),
    });
    expect(graph.nodes).toContainEqual({
      id: author,
      type: 'schema:Person',
      label: 'Author',
      summary: summary(author, 'schema:Person', { value: 'Author', language: 'en' }, expectedCover(enCover)),
    });
    expect((await get(`/v1/subjects/${book}`, languages)).summary).toEqual(graph.nodes[0].summary);
  }
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    const revision = await client.query(
      'SELECT recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
      [32064, author],
    );
    await expandSlot(client, author, 'schema:image', revision.rows[0].recorded_transaction_id);
    await client.query(
      `INSERT INTO semantic.statement_disclosure(route,subject_id,candidate_id,target_id,account_id,property,source_order_key,target_order_key)
       SELECT route,subject_id,candidate_id,$3,$4,'schema:image','',''
       FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND property='schema:image'`,
      [32064, author, enCover, actor.accountId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const privateImage = await get(graphPath(book, ['schema:author']));
  expect(privateImage.nodes.find((node: { id: string }) => node.id === author).summary).toEqual(
    summary(author, 'schema:Person', { value: 'Author', language: 'en' }),
  );
  await db.admin.query(
    'UPDATE content.media SET taken_down=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [32016, jaCover],
  );
  expect((await get(graphPath(book), 'fr')).nodes[0].summary.cover).toBeNull();
  denied.add(en);
  expect((await get(graphPath(book), 'en')).nodes[0].summary.cover).toBeNull();
  denied.delete(en);
});

test('undisclosed graph nodes disclose no summary or attached edges', async () => {
  const orphan = await subject('schema:Book', 32112, { en: 'Orphan' });
  const shared = await subject('schema:Book', 32113, { en: 'Shared' });
  const children = await Promise.all(
    Array.from({ length: 6 }, (_, i) => subject('schema:Book', 32128, { en: `Child ${i}` })),
  );
  const unreadable = await subject(
    'schema:Book',
    32144,
    { en: 'Unreadable' },
    { 'rezics:sameSetting': [orphan, shared, ...children].map((id) => value('rezics:sameSetting', id)) },
  );
  const hidden = await subject('schema:Book', 32160, { en: 'Hidden' });
  const taken = await subject('schema:Book', 32176, { en: 'Taken down' });
  const visible = await subject(
    'schema:Book',
    32192,
    { en: 'Visible' },
    {
      'rezics:sameSetting': [value('rezics:sameSetting', shared)],
    },
  );
  const formerTarget = await subject('schema:Book', 32208, { en: 'Former target' });
  const missing = newId(32208);
  const book = await subject(
    'schema:Book',
    32224,
    { en: 'Anchor' },
    {
      'rezics:sameSetting': [unreadable, hidden, taken, visible, formerTarget].map((id) =>
        value('rezics:sameSetting', id),
      ),
    },
  );
  await catchUp();
  // Leave stale projection rows in place: disclosure must be checked at read time.
  await db.admin.query(
    'UPDATE semantic.outbound_link SET target_subject_id=$3 WHERE route=$1 AND subject_id=$2 AND target_subject_id=$4',
    [32224, book, missing, formerTarget],
  );
  for (const [id, visibility] of [
    [hidden, 'hidden'],
    [taken, 'taken_down'],
  ])
    await db.admin.query(
      'UPDATE semantic.subject SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
      [routeOf(id!)!, id, visibility],
    );
  denied.add(unreadable);
  checked.clear();
  const graph = await get(graphPath(book, ['rezics:sameSetting'], 5));
  expect(checked.has(unreadable)).toBe(true);
  expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual([book, visible, shared]);
  expect(graph.edges).toEqual([
    { from: book, property: 'rezics:sameSetting', to: visible, statement: expect.any(String) },
    { from: visible, property: 'rezics:sameSetting', to: shared, statement: expect.any(String) },
  ]);
  expect(graph.truncated).toEqual([]);
  for (const id of [unreadable, hidden, taken, missing, orphan, ...children])
    expect(JSON.stringify(graph)).not.toContain(id);
  denied.delete(unreadable);
  const restored = await get(graphPath(book, ['rezics:sameSetting'], 5));
  expect(restored.nodes.map((node: { id: string }) => node.id)).toContain(unreadable);
  expect(restored.truncated).toEqual([expect.objectContaining({ node: unreadable, count: 8 })]);
});

test('bounded graph summary filling preserves the shared 256 ID limit', async () => {
  const branches: string[] = [];
  for (let branch = 0; branch < 20; branch++) {
    const leaves: string[] = [];
    for (let leaf = 0; leaf < 25; leaf++)
      leaves.push(await subject('schema:Book', 40000 + (leaf % 2) * 16, { en: `Leaf ${branch}-${leaf}` }));
    branches.push(
      await subject(
        'schema:Book',
        40000 + (branch % 2) * 16,
        { en: `Branch ${String(branch).padStart(2, '0')}` },
        { 'rezics:sameSetting': leaves.map((id) => value('rezics:sameSetting', id)) },
      ),
    );
  }
  const anchor = await subject(
    'schema:Book',
    40000,
    { en: 'Anchor' },
    { 'rezics:sameSetting': branches.map((id) => value('rezics:sameSetting', id)) },
  );
  await catchUp();
  await settle(db, { analyze: true });
  await get(graphPath(anchor));
  await settle(db, { analyze: true });
  const measured = await capture(db, () => get(graphPath(anchor)));
  const graph = measured.value;
  expect(graph.nodes).toHaveLength(501);
  expect(graph.edges).toHaveLength(500);
  expect(new Set(graph.nodes.map((node: { id: string }) => node.id)).size).toBe(501);
  expect(graph.nodes[0].id).toBe(anchor);
  for (const node of graph.nodes) {
    expect(node.summary).toEqual(summary(node.id, 'schema:Book', { value: node.label, language: 'en' }));
  }
  expect(
    graph.truncated.every((entry: { node: string }) =>
      graph.nodes.some((node: { id: string }) => node.id === entry.node),
    ),
  ).toBe(true);
  // Two chunks, each touching both subject partitions. Count actual shared SQL, including its representative probes.
  const summaryReads = measured.capture.statements.filter((text) =>
    text.includes('Only the requested image, representative-edition and original-language slots'),
  );
  const representativeReads = measured.capture.statements.filter((text) =>
    text.includes('row_number() OVER (ORDER BY ordered.order_key'),
  );
  expect(summaryReads).toHaveLength(4);
  expect(representativeReads).toHaveLength(4);
  expect(partitionOf(routeOf(anchor)!)).toBe(2500);
  const cost = costOf(measured.capture);
  console.info(
    'Graph summary measured report',
    JSON.stringify({
      nodes: 501,
      edges: 500,
      chunks: 2,
      partitions: 2,
      summaryReads: summaryReads.length,
      representativeReads: representativeReads.length,
      rows: cost.rows,
      blocks: cost.blocks,
      statements: cost.statements,
    }),
  );
}, 600_000);
