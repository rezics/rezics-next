import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient, type QueryConfig } from 'pg';
import sharp from 'sharp';
import { createCollectionJob } from '../../src/content/collection-job.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { claimMedia, type MediaState } from '../../src/content/media.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const partition = 301;
const route = partition * 16;
const at = '2030-01-02T00:00:00.000Z';
const old = '2030-01-01T00:00:00.000Z';
const young = '2030-01-01T00:00:01.000Z';
const clock = () => new Date(at);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const records: { text: string; values: readonly unknown[] }[] = [];
const holds: { match(text: string, values: readonly unknown[]): boolean; stop(): Promise<void> }[] = [];
function gate() {
  let release!: () => void;
  let enter!: () => void;
  return {
    entered: new Promise<void>((resolve) => (enter = resolve)),
    released: new Promise<void>((resolve) => (release = resolve)),
    enter: () => enter(),
    release: () => release(),
  };
}
// Observe the real driver boundary; all SQL still executes against migrated PostgreSQL.
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = (async (input: string | QueryConfig, values?: unknown[]) => {
    const text = typeof input === 'string' ? input : input.text;
    const parameters = values ?? (typeof input === 'string' ? [] : (input.values ?? []));
    records.push({ text, values: parameters });
    const result = await query(input, values);
    const index = holds.findIndex((hold) => hold.match(text, parameters));
    if (index !== -1) await holds.splice(index, 1)[0]!.stop();
    return result;
  }) as PoolClient['query'];
});
function afterSelection() {
  const barrier = gate();
  holds.push({
    match: (text) => /FROM content\.media\b/.test(text) && /ORDER BY/.test(text),
    stop: async () => {
      barrier.enter();
      await barrier.released;
    },
  });
  return barrier;
}
class Storage implements MediaStorage {
  readonly keys = new Map<string, Uint8Array>();
  readonly deletions: string[] = [];
  failAfter: number | undefined;
  deleting: ReturnType<typeof gate> | undefined;
  writing: ReturnType<typeof gate> | undefined;
  async get(key: string) {
    return this.keys.get(key) ?? null;
  }
  async put(key: string, bytes: Uint8Array) {
    const barrier = this.writing;
    this.writing = undefined;
    if (barrier) {
      barrier.enter();
      await barrier.released;
    }
    this.keys.set(key, bytes);
  }
  async deletePrefix(prefix: string) {
    this.deletions.push(prefix);
    const barrier = this.deleting;
    this.deleting = undefined;
    if (barrier) {
      barrier.enter();
      await barrier.released;
    }
    let deleted = 0;
    for (const key of this.keys.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (this.failAfter === deleted) {
        this.failAfter = undefined;
        throw new Error('remote prefix deletion failed');
      }
      this.keys.delete(key);
      deleted++;
    }
  }
}
let storage = new Storage();
function job(selectedPool = pool) {
  return createCollectionJob(selectedPool, storage, { clock });
}
async function media(
  state: MediaState = 'available',
  createdAt = old,
  selectedRoute = route,
  bytes = Buffer.from('original'),
) {
  const id = newId(selectedRoute);
  const containerId = newId(selectedRoute);
  const uploaderId = newId(99);
  await admin.query(
    `INSERT INTO content.media
    (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
     actual_byte_count,sha256,state,decision,key,created_at,transaction_id)
    VALUES ($1,$2::uuid,$3,$4,$2::uuid::text,'post-image','image/png',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      selectedRoute,
      id,
      containerId,
      uploaderId,
      bytes.length,
      state === 'reserved' ? null : bytes.length,
      state === 'reserved' ? null : hash(bytes),
      state,
      state === 'rejected' ? 'invalid-image' : null,
      `m/${id}/original`,
      createdAt,
      randomUUID(),
    ],
  );
  storage.keys.set(`m/${id}/original`, bytes);
  if (state === 'available') {
    for (const format of ['webp', 'avif']) {
      const key = `m/${id}/${format}-320`;
      const derivative = Buffer.from(format);
      storage.keys.set(key, derivative);
      await admin.query(
        `INSERT INTO content.media_variant
        (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
        VALUES ($1,$2,$3,320,160,$4,$5,$6,$7,$8)`,
        [selectedRoute, id, format, `image/${format}`, derivative.length, hash(derivative), key, randomUUID()],
      );
    }
  }
  return { id, containerId, uploaderId, route: selectedRoute };
}
type Media = Awaited<ReturnType<typeof media>>;
async function row(m: Media) {
  return (await admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [m.route, m.id])).rows[0];
}
async function effects() {
  return (
    await admin.query(
      `SELECT
    (SELECT count(*)::int FROM core.receipt) receipts,
    (SELECT count(*)::int FROM core.outbox) events,
    (SELECT position FROM core.partition WHERE partition_no=$1) position`,
      [partition],
    )
  ).rows[0];
}
async function reference(m: Media) {
  const board = newId(route);
  await admin.query(
    `INSERT INTO content.board
    (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Board','published',1,$4)`,
    [route, board, newId(route), randomUUID()],
  );
  await admin.query(
    `INSERT INTO content.thread
    (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Thread','published',1,$5)`,
    [route, m.containerId, m.uploaderId, board, randomUUID()],
  );
  const itemId = newId(route),
    revisionId = newId(route),
    key = randomUUID();
  const body = Buffer.from(
    JSON.stringify({
      version: 'rezics-document-v1',
      profile: 'blocks',
      doc: { type: 'doc', content: [{ type: 'image', attrs: { src: `media:${m.id}` } }] },
    }),
  );
  const result = runCommand(
    pool,
    {
      partition,
      clock,
      basis: { actorAccountId: m.uploaderId, clientId: 'website', requestedBy: null },
      // This native collection fixture starts with trusted post:create authority.
      // Full API authorization is covered by the media outcomes suite.
      authorization: {
        action: 'post:create',
        resource: { route, id: m.containerId },
        authorize: async () => 'execute',
        denied: () => new Error('Reference command denied'),
      },
      receipt: {
        actorAccountId: m.uploaderId,
        kind: 'content.post.create',
        key,
        digest: Buffer.from(hash(body), 'hex'),
      },
    },
    async (tx, command) => {
      await tx.query(
        `INSERT INTO content.post
        (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
        [route, m.containerId, itemId, m.uploaderId, revisionId, command.transactionId],
      );
      await tx.query(
        `INSERT INTO content.revision
        (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
        VALUES ($1,$2,$3,$4,$5,sha256($5),'','CC0-1.0','{}',$6,'available',$7)`,
        [route, m.containerId, itemId, revisionId, body, board, command.transactionId],
      );
      await claimMedia(tx, {
        mediaIds: [m.id],
        containerId: m.containerId,
        itemId,
        revisionId,
        author: {
          kind: 'account',
          accountId: m.uploaderId,
          clientId: 'website',
          requestedBy: null,
          authnEpoch: 1,
          scopes: [],
        },
      });
      return {
        value: { revisionId, at: authoritativeTimeValue(command.time) },
        events: [
          {
            type: 'com.rezics.content.post.created.v1',
            subject: itemId,
            data: {
              threadId: m.containerId,
              itemId,
              revisionId,
              actorId: m.uploaderId,
              ...SUBJECT_THREAD_EVENT_FIELDS,
            },
          },
        ],
      };
    },
  );
  return result;
}
beforeEach(async () => {
  await admin.query(`TRUNCATE content.media,content.media_variant,content.revision,content.post,content.thread,content.board,
    core.receipt,core.outbox,editorial.write_basis CASCADE`);
  await admin.query('UPDATE core.partition SET position=0');
  storage = new Storage();
  records.length = 0;
  holds.length = 0;
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('all unclaimed states collect at exactly 24 hours; younger, claimed, erased and remote objects survive', async () => {
  const targets = await Promise.all(
    (['reserved', 'uploaded', 'available', 'rejected'] as const).map((state, i) => media(state, old, route + i)),
  );
  const younger = await media('available', young),
    claimed = await media(),
    erased = await media();
  const remote = await media('available', old, route + 16);
  await admin.query('UPDATE content.media SET claimed_at=$3 WHERE route=$1 AND media_id=$2', [route, claimed.id, at]);
  await admin.query(
    'UPDATE content.media SET erased=true, security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [route, erased.id],
  );
  const retained = [younger, claimed, erased, remote].flatMap((m) =>
    [...storage.keys.keys()].filter((key) => key.startsWith(`m/${m.id}/`)),
  );
  expect(await job().collectPartition(partition, 100)).toMatchObject({ partition, collected: 4, complete: true });
  for (const m of targets) {
    expect(await row(m)).toBeUndefined();
    expect([...storage.keys.keys()].filter((k) => k.startsWith(`m/${m.id}/`))).toEqual([]);
  }
  for (const m of [younger, claimed, erased, remote]) expect(await row(m)).toBeDefined();
  for (const key of retained) expect(storage.keys.has(key)).toBe(true);
  const snapshot = await effects();
  expect(await job().collectPartition(partition, 100)).toMatchObject({ examined: 0, collected: 0, complete: true });
  expect(await effects()).toEqual(snapshot);
  const events = (await admin.query('SELECT type,data FROM core.outbox')).rows;
  for (const event of events) expect(Object.hasOwn(CONTENT_EVENTS(), event.type)).toBe(true);
  expect(events.filter((e) => e.type === 'com.rezics.content.media.collected.v1')).toHaveLength(4);
  expect(await job().collectPartition(partition + 1, 1)).toMatchObject({ collected: 1 });
});

for (const failAfter of [0, 1])
  test(`prefix failure after ${failAfter} keys leaves a durable fence and retries all variants`, async () => {
    const m = await media();
    storage.failAfter = failAfter;
    await expect(job().collectPartition(partition, 1)).rejects.toThrow('remote prefix deletion failed');
    expect(await row(m)).toMatchObject({ collection_pending: true, claimed_at: null });
    expect(storage.keys.size).toBe(3 - failAfter);
    // Pending retries remain eligible even if metadata age is subsequently corrected.
    await admin.query('UPDATE content.media SET created_at=$3 WHERE route=$1 AND media_id=$2', [route, m.id, at]);
    expect(await job().collectPartition(partition, 1)).toMatchObject({ collected: 1 });
    expect(await row(m)).toBeUndefined();
    expect(storage.keys.size).toBe(0);
    expect(
      (await admin.query("SELECT * FROM core.outbox WHERE type='com.rezics.content.media.collected.v1'")).rows,
    ).toHaveLength(1);
  });

test('selection enumerates sixteen exact routes with two bounded seeks and caps each step at 100', async () => {
  for (let i = 0; i < 105; i++) await media('reserved', old, route + (i % 16));
  records.length = 0;
  expect(await job().collectPartition(partition, 100)).toMatchObject({ collected: 100, complete: false });
  const selections = records.filter(({ text }) => /FROM content\.media\b/.test(text) && /ORDER BY/.test(text));
  expect(selections).toHaveLength(16);
  expect(
    selections
      .map(({ text, values }) => {
        const bindings = [...text.matchAll(/\$(\d+)::integer\s+AS\s+route\b/gi)];
        expect(bindings).toHaveLength(1);
        expect(text.match(/media\.route\s*=\s*input\.route\b/gi)).toHaveLength(2);
        return values[Number(bindings[0]![1]) - 1];
      })
      .sort((a, b) => Number(a) - Number(b)),
  ).toEqual(Array.from({ length: 16 }, (_, i) => route + i));
  for (const { text, values } of selections) {
    expect(text).not.toMatch(/\bBETWEEN\b|\bOFFSET\b/i);
    expect(text.match(/\bLIMIT\b/gi)).toHaveLength(2);
    expect(values).toContain(100);
  }
  expect(await job().collectPartition(partition, 100)).toMatchObject({ collected: 5, complete: true });
  for (const bad of [0, 101, 1.5]) await expect(job().collectPartition(partition, bad)).rejects.toThrow(RangeError);
  for (const bad of [-1, 4096, 1.5]) await expect(job().collectPartition(bad, 1)).rejects.toThrow(RangeError);
});

test('duplicate jobs replay per-object commands without duplicate collected effects', async () => {
  const m = await media();
  const barrier = gate();
  storage.deleting = barrier;
  const first = job().collectPartition(partition, 1);
  await barrier.entered;
  try {
    await job().collectPartition(partition, 1);
  } finally {
    barrier.release();
    await first;
  }
  await first;
  expect(await row(m)).toBeUndefined();
  expect(storage.keys.size).toBe(0);
  expect(
    (await admin.query("SELECT * FROM core.outbox WHERE type='com.rezics.content.media.collected.v1'")).rows,
  ).toHaveLength(1);
  expect((await effects()).receipts).toBe(2);
});

test('claim commits after actual selection and fence revalidation preserves its reference and bytes', async () => {
  const m = await media();
  const barrier = afterSelection();
  const collection = job().collectPartition(partition, 1);
  await barrier.entered;
  try {
    await reference(m);
  } finally {
    barrier.release();
    await collection;
  }
  expect(await collection).toMatchObject({ collected: 0 });
  expect(await row(m)).toMatchObject({ state: 'available', claimed_at: new Date(at), collection_pending: false });
  expect(storage.keys.size).toBe(3);
  expect((await admin.query('SELECT body FROM content.revision')).rows[0].body.toString()).toContain(m.id);
});

test('collection commits its fence before deletion and claim refuses with no reference or receipt', async () => {
  const m = await media();
  const barrier = gate();
  storage.deleting = barrier;
  const collection = job().collectPartition(partition, 1);
  await barrier.entered;
  try {
    expect(await row(m)).toMatchObject({ collection_pending: true });
    const before = await effects();
    const error = await reference(m).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ name: 'UnfinishedPortError' });
    expect(await effects()).toEqual(before);
    expect((await admin.query('SELECT * FROM content.revision')).rows).toEqual([]);
  } finally {
    barrier.release();
    await collection;
  }
  await collection;
  expect(storage.keys.size).toBe(0);
});

test('processing holds the actual row lock until all writes publish before collection can fence', async () => {
  const bytes = await sharp({ create: { width: 127, height: 61, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const m = await media('uploaded', old, route, bytes);
  const barrier = gate();
  storage.writing = barrier;
  const image = createImageJob(pool, storage).process(m.id);
  await barrier.entered;
  const selection = afterSelection();
  const collection = job().collectPartition(partition, 1);
  await selection.entered;
  selection.release();
  barrier.release();
  await image;
  await collection;
  expect(await row(m)).toBeUndefined();
  expect(storage.keys.size).toBe(0);
  await createImageJob(pool, storage).process(m.id);
  expect(storage.keys.size).toBe(0);
});

test('processing started after a committed collection fence never writes', async () => {
  const m = await media('uploaded');
  const barrier = gate();
  storage.deleting = barrier;
  const collection = job().collectPartition(partition, 1);
  await barrier.entered;
  try {
    const result = await createImageJob(pool, storage).process(m.id);
    expect(result.state).toBe('already_terminal');
    expect([...storage.keys.keys()]).toEqual([`m/${m.id}/original`]);
  } finally {
    barrier.release();
    await collection;
  }
  await collection;
  expect(storage.keys.size).toBe(0);
});

test('checkGrowth measures three scales of unrelated and same-partition rows through the real production pool', async () => {
  const db = await openGrowthDatabase(url);
  async function grow(db: GrowthDatabase, scale: number, previous: number) {
    // Bulk fixture setup is outside measurement. Grow the same hot routes and
    // another partition, including variants and command history, at every scale.
    await seed(
      db,
      {
        name: 'collection-distractors',
        hotPartition: partition,
        rows: ({ ordinal }) => {
          const mediaRows = [route, route + 1, route + 16].map((r) => {
            const id = newId(r);
            const claimed = r === route + 1;
            return {
              route: r,
              media_id: id,
              container_id: newId(r),
              uploader_id: newId(99),
              reservation_request_id: id,
              purpose: 'post-image',
              media_type: 'image/png',
              byte_count: 8,
              actual_byte_count: claimed ? 8 : null,
              sha256: claimed ? hash(Buffer.from('original')) : null,
              state: claimed ? 'available' : 'reserved',
              key: `m/${id}/original`,
              claimed_at: claimed ? at : null,
              created_at: young,
              transaction_id: randomUUID(),
            };
          });
          const variantRows = mediaRows
            .filter((m) => m.claimed_at !== null)
            .flatMap((m) =>
              ['webp', 'avif'].map((format) => ({
                route: m.route,
                media_id: m.media_id,
                format,
                width: 320,
                height: 160,
                media_type: `image/${format}`,
                byte_count: 4,
                sha256: hash(Buffer.from(format)),
                key: `m/${m.media_id}/${format}-320`,
                transaction_id: randomUUID(),
              })),
            );
          const history = [partition, partition + 1].map((p) => ({
            partition_no: p,
            position: ordinal * 100 + 100,
            epoch: 1,
            transaction_id: randomUUID(),
            actor_account_id: newId(99),
            media_id: newId(p * 16),
            container_id: newId(p * 16),
          }));
          return {
            'content.media': mediaRows,
            'content.media_variant': variantRows,
            'core.receipt': history.map((h) => ({
              partition_no: h.partition_no,
              principal_kind: 'account',
              principal_id: h.actor_account_id,
              command_kind: 'content.media.collection.fence',
              idempotency_key: h.media_id,
              request_digest: createHash('sha256').update(`content.media.collection.fence:${h.media_id}`).digest(),
              epoch: h.epoch,
              position: h.position,
              transaction_id: h.transaction_id,
              response: { mediaId: h.media_id, containerId: h.container_id },
            })),
            'core.outbox': history.map((h) => ({
              partition_no: h.partition_no,
              position: h.position,
              event_seq: 0,
              event_count: 1,
              epoch: h.epoch,
              id: randomUUID(),
              type: 'com.rezics.content.media.collection-pending.v1',
              subject: h.media_id,
              data: { mediaId: h.media_id, containerId: h.container_id },
            })),
            'editorial.write_basis': history.map((h) => ({
              partition_no: h.partition_no,
              transaction_id: h.transaction_id,
              epoch: h.epoch,
              position: h.position,
              principal_kind: 'account',
              principal_id: h.actor_account_id,
              client_id: 'website',
              requested_by: null,
            })),
          };
        },
        finish: async (admin) => {
          // Leave gaps for measured command positions between successive ranges.
          await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=ANY($1::integer[])', [
            [partition, partition + 1],
            scale * 100,
          ]);
        },
      },
      { from: previous, to: scale },
    );
    // One warm-up and two measured runs consume one fresh object each; new IDs give new command receipts.
    await media('reserved');
    await media('reserved');
    await media('reserved');
    await db.admin.query('VACUUM (ANALYZE) content.media');
    for (const relation of [
      'content.media',
      'content.media_variant',
      'core.partition',
      'core.receipt',
      'core.outbox',
      'editorial.write_basis',
    ]) {
      // Population counts validate fixture setup only; they are never measured work.
      const count = await db.admin.query(`SELECT count(*)::integer AS rows FROM ${relation}`);
      expect(count.rows[0].rows).toBeGreaterThanOrEqual(500);
    }
  }
  try {
    const report = await checkGrowth(db, {
      name: 'partition media collection',
      scales: [256, 1024, 4096],
      repetitions: 2,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow,
      async warmup(database) {
        expect(await job(database.pool).collectPartition(partition, 1)).toMatchObject({ collected: 1 });
      },
      operation: async (db) => {
        expect(await job(db.pool).collectPartition(partition, 1)).toMatchObject({ collected: 1 });
      },
    });
    console.log('GrowthReport', JSON.stringify(report));
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      expect(sample.cost.relations).toBeDefined();
      if (!sample.cost.relations) throw new Error(`Missing relation costs at scale ${sample.scale}`);
      const relations = Object.entries(sample.cost.relations).filter(([name]) => name.startsWith('content.'));
      expect(relations.map(([name]) => name).sort()).toEqual(['content.media', 'content.media_variant']);
      for (const [name, cost] of relations) {
        expect(cost.sequentialScans, `${sample.scale}: ${name}`).toBe(0);
      }
    }
    const observed = await capture(db, () => job(db.pool).collectPartition(partition, 1));
    const plans = JSON.stringify(observed.capture.plans);
    expect(plans).toContain('media_collection_eligible_idx');
    expect(plans).toContain('media_collection_pending_idx');
    expect(plans).not.toContain('Seq Scan');
    expect(observed.capture.statements.filter((text) => /FROM content\.media\b/.test(text))).toHaveLength(16);
    expect(partitionOf(routeOf(newId(route))!)).toBe(partition);
  } finally {
    await db.close();
  }
});
