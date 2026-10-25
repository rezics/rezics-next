import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { checkMediaObject } from '../../src/content/cover-reference.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 42000;
const containerId = newId(route);
const uploaderId = newId(42016);
const digest = 'a'.repeat(64);
const request: MediaImportRequest = {
  containerId,
  sourceUrl: 'https://images.example.test/original.jpg',
  credit: {
    rightsHolder: 'Image Artist',
    via: { name: 'Example Catalogue', url: 'https://catalogue.example.test/record/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'example-catalogue',
    external_id: 'record-42',
    record_revision: 'edition-3',
    digest: 'b'.repeat(64),
    converter_revision: 'converter-2',
    field_group: 'cover',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/42' } },
          { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
          { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
        ],
      },
    ],
  },
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  expect(checkMediaImportRequest(request)).toEqual([]);
});
afterAll(async () => {
  await db?.close();
});

async function reserve(purpose = 'cover') {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
        media_type, byte_count, state, key, transaction_id, source_url, credit, provenance)
     VALUES ($1,$2::uuid,$3,$4,$2::text,$5,NULL,NULL,'reserved',$6,$2::uuid,$7,$8,$9)`,
    [
      route,
      id,
      containerId,
      uploaderId,
      purpose,
      `m/${id}/original`,
      request.sourceUrl,
      request.credit,
      request.provenance,
    ],
  );
  return id;
}
async function available() {
  const id = await reserve();
  await db.admin.query(
    `UPDATE content.media SET state='uploaded', byte_count=256, actual_byte_count=256,
       media_type='image/jpeg', sha256=$3 WHERE route=$1 AND media_id=$2`,
    [route, id, digest],
  );
  await db.admin.query("UPDATE content.media SET state='available' WHERE route=$1 AND media_id=$2", [route, id]);
  return id;
}
async function read(id: string) {
  const client = await db.pool.connect();
  try {
    return await checkMediaObject(client, id, 'cover');
  } finally {
    client.release();
  }
}
async function constraint(sql: string, values: unknown[]) {
  await expect(db.admin.query(sql, values)).rejects.toMatchObject({ code: '23514' });
}

test('URL cover reservation has no invented measurements; website reservations remain strict', async () => {
  const id = await reserve();
  expect(
    (
      await db.admin.query(
        'SELECT byte_count, media_type, sha256, actual_byte_count FROM content.media WHERE route=$1 AND media_id=$2',
        [route, id],
      )
    ).rows,
  ).toEqual([{ byte_count: null, media_type: null, sha256: null, actual_byte_count: null }]);
  expect(await read(id)).toBeNull();
  for (const assignments of [
    "purpose='post-image'",
    "state='uploaded'",
    "state='uploaded', actual_byte_count=256, sha256='" + digest + "'",
    'byte_count=0',
    "media_type='application/octet-stream'",
    'credit=NULL',
    'provenance=NULL',
    'source_url=NULL',
    "provenance=jsonb_set(provenance,'{field_group}','\"summary\"')",
  ])
    await constraint(`UPDATE content.media SET ${assignments} WHERE route=$1 AND media_id=$2`, [route, id]);
  const websiteId = newId(route);
  await db.admin.query(
    `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,
       media_type,byte_count,state,key,transaction_id)
     VALUES ($1,$2::uuid,$3,$4,$2::text,'post-image','image/jpeg',256,'reserved',$5,$2::uuid)`,
    [route, websiteId, containerId, uploaderId, `m/${websiteId}/original`],
  );
  for (const column of ['byte_count', 'media_type'])
    await constraint(`UPDATE content.media SET ${column}=NULL WHERE route=$1 AND media_id=$2`, [route, websiteId]);
  expect(await read(websiteId)).toBeNull();
});

test('available cover returns exact image rights and the original source tuple without claiming or exposing fetch URL', async () => {
  const id = await available();
  const expected = {
    id,
    digest,
    containerId,
    rights: {
      license: 'LicenseRef-unknown',
      obligations: [],
      attribution: '(c) Image Artist; via [Example Catalogue](https://catalogue.example.test/record/42)',
    },
    source: request.provenance,
  };
  expect(await read(id)).toEqual(expected);
  expect(await read(id)).toEqual(expected);
  expect(
    (await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [route, id])).rows,
  ).toEqual([{ claimed_at: null }]);
  expect(JSON.stringify(expected)).not.toContain(request.sourceUrl);
});

test('reference reader denies unknown, malformed, unprocessed, rejected, erased, collection pending and taken down objects', async () => {
  expect(await read(newId(route))).toBeNull();
  expect(await read('not-an-id')).toBeNull();
  const reserved = await reserve();
  expect(await read(reserved)).toBeNull();
  const uploaded = await available();
  await db.admin.query("UPDATE content.media SET state='uploaded' WHERE route=$1 AND media_id=$2", [route, uploaded]);
  expect(await read(uploaded)).toBeNull();
  for (const assignment of [
    "state='rejected', decision='invalid_image'",
    'erased=true',
    'collection_pending=true',
    'taken_down=true, security_revision=1',
  ]) {
    const id = await available();
    await db.admin.query(`UPDATE content.media SET ${assignment} WHERE route=$1 AND media_id=$2`, [route, id]);
    expect(await read(id)).toBeNull();
  }
  const id = await available();
  const alienId = newId(route + 16);
  await constraint('UPDATE content.media SET container_id=$3 WHERE route=$1 AND media_id=$2', [route, id, alienId]);
  expect(await read(alienId)).toBeNull();
});

test('invalid rights or provenance fail closed and governance revision cannot regress or be cleared by refresh', async () => {
  const id = await available();
  await db.admin.query(
    "UPDATE content.media SET credit=jsonb_set(credit,'{license}','\"unknown\"') WHERE route=$1 AND media_id=$2",
    [route, id],
  );
  expect(await read(id)).toBeNull();
  await db.admin.query(
    'UPDATE content.media SET credit=$3, taken_down=true, security_revision=2 WHERE route=$1 AND media_id=$2',
    [route, id, request.credit],
  );
  await db.admin.query('UPDATE content.media SET provenance=$3 WHERE route=$1 AND media_id=$2', [
    route,
    id,
    request.provenance,
  ]);
  expect(await read(id)).toBeNull();
  await constraint('UPDATE content.media SET taken_down=false WHERE route=$1 AND media_id=$2', [route, id]);
  await constraint('UPDATE content.media SET security_revision=1 WHERE route=$1 AND media_id=$2', [route, id]);
});

test('exact cover lookup has bounded actual rows, statements and buffers among same-partition media', async () => {
  const id = await available();
  const report = await checkGrowth(db, {
    name: 'exact cover reference',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      for (let i = previous; i < scale; i++) await reserve();
      await database.admin.query('ANALYZE content.media');
    },
    async operation() {
      expect((await read(id))?.id).toBe(id);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(1);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeLessThanOrEqual(2);
    expect(sample.cost.blocks).toBeGreaterThan(0);
  }
}, 60000);
