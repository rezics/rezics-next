import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/contract.ts';
import { ShowcaseRefused, type ShowcaseSelectionInput } from '../src/modules/media/showcase-contract.ts';
import { SHOWCASE_BATCH_SQL, SHOWCASE_LOGO_CAPACITY_SQL } from '../src/modules/media/showcase-store.ts';
import { MediaStore } from '../src/modules/media/store.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `showcase-capacity-${randomUUID()}`);
const native = () => `https://rezics.com/id/${randomUUID()}`;
const actor = native();
const principal = randomUUID();
const admission = () => ({ admissionId: randomUUID(), principalId: principal,
  actingSubject: actor, authorityEpoch: '1', requestDigest: 'a'.repeat(64) });
const inspect = async () => ({ width: 640, height: 480, hasAlpha: true });
const eight = ['en', 'ja', 'zh-Hant', 'zh-Hans', 'ko', 'fr', 'de', 'es'];
let cluster: PostgresCluster | undefined;
let admin: Pool | undefined;
let asset: string;
let legacy: { active: string; removed: string; empty: string; trailer: string; avatar: string };

const logo = (target: string, language: string, tone: 'light' | 'dark' = 'light',
  context = DEFAULT_MEDIA_CONTEXT): ShowcaseSelectionInput => ({ target, context,
  expectedSelection: null, role: 'logo', language, tone, anchor: 'center-top',
  asset, crop: null, focalArea: null });

const poolFor = (database: string) => new Pool({ ...cluster!.connection, database, max: 8 });

/** Build the migrated owner and exact source once; each test restores an isolated copy. */
beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  cluster = await startPostgresCluster();
  admin = poolFor('postgres');
  await admin.query('CREATE DATABASE showcase_capacity_template');
  const pool = poolFor('showcase_capacity_template');
  try {
    const previous = join(state, 'migrations');
    mkdirSync(previous);
    for (const name of schemaFiles(root, 'content')) {
      if (!name.includes('_media_showcase_active'))
        copyFileSync(join(root, 'services/content/migrations', name), join(previous, name));
    }
    await migrateContent(pool, previous);
    const store = new MediaStore(pool, new ContentCore(pool));
    const upload = await store.reserveUpload(admission(), { asset: null, mediaType: 'image/png',
      byteLength: 32, sha256: 'b'.repeat(64), disclosure: 'public' });
    asset = upload.asset;
    await store.settleUpload(upload.upload, { status: 'activated', sha256: 'b'.repeat(64),
      byteLength: 32, mediaType: 'image/png', width: 640, height: 480 });
    await store.recordAssetRevision(upload.upload);
    legacy = { active: native(), removed: native(), empty: native(), trailer: native(), avatar: native() };
    const cutout: ShowcaseSelectionInput = { target: legacy.active, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: null, role: 'cutout', asset, crop: null, focalArea: null };
    await store.showcase.select(admission(), cutout, inspect);
    const removed = await store.showcase.select(admission(), { ...cutout, target: legacy.removed }, inspect);
    await store.showcase.select(admission(), { ...cutout, target: legacy.removed,
      expectedSelection: removed.id, asset: null }, inspect);
    await store.showcase.select(admission(), { target: legacy.trailer, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: null, url: 'https://youtu.be/dQw4w9WgXcQ' }, inspect);
    await pool.query(`INSERT INTO media.selection_slot(target,context,role,policy)
      VALUES ($1,$3,'showcase-cutout','showcase-selection-v1'),($2,$3,'avatar','avatar-selection-v1')`,
    [legacy.empty, legacy.avatar, DEFAULT_MEDIA_CONTEXT]);
    await migrateContent(pool);
    expect(await migrateContent(pool)).toEqual([]);
  } finally { await pool.end(); }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
  rmSync(state, { recursive: true, force: true });
});

async function isolated(label: string, run: (pool: Pool, store: MediaStore) => Promise<void>) {
  // Labels are static identifiers authored below, never external input.
  const database = `showcase_capacity_${label}`;
  await admin!.query(`CREATE DATABASE ${database} TEMPLATE showcase_capacity_template`);
  const pool = poolFor(database);
  try { await run(pool, new MediaStore(pool, new ContentCore(pool))); }
  finally {
    await pool.end();
    await admin!.query(`DROP DATABASE ${database}`);
  }
}

async function selected(store: MediaStore, input: ShowcaseSelectionInput) {
  const result = await store.showcase.select(admission(), input, inspect);
  expect(result.outcome).toBe('succeeded');
  expect(result.id).not.toBeNull();
  return result.id!;
}

async function languages(pool: Pool, target: string, context = DEFAULT_MEDIA_CONTEXT) {
  return ((await pool.query(SHOWCASE_LOGO_CAPACITY_SQL, [target, context])).rows[0].languages ?? []) as string[];
}

test('owner migration derives active images and trailers while preserving removed and empty heads', async () => {
  await isolated('upgrade', async (pool) => {
    const flags = (await pool.query(`SELECT target,showcase_active FROM media.selection_slot
      WHERE target=ANY($1::text[])`, [Object.values(legacy)])).rows;
    const active = new Map(flags.map(row => [row.target, row.showcase_active]));
    expect(active.get(legacy.active)).toBe(true);
    expect(active.get(legacy.trailer)).toBe(true);
    for (const target of [legacy.removed, legacy.empty, legacy.avatar]) expect(active.get(target)).toBe(false);
    await pool.query('UPDATE media.selection_slot SET showcase_active=NOT showcase_active');
    expect((await pool.query('SELECT target,showcase_active FROM media.selection_slot ORDER BY target')).rows)
      .toEqual([...flags].sort((a, b) => a.target.localeCompare(b.target)));
    const removed = (await pool.query('SELECT head FROM media.selection_slot WHERE target=$1', [legacy.removed])).rows[0].head;
    await expect(pool.query('DELETE FROM media.selection_slot WHERE target=$1', [legacy.removed])).rejects.toThrow();
    await expect(pool.query('DELETE FROM media.selection_revision WHERE id=$1', [removed])).rejects.toThrow();
    await expect(pool.query('UPDATE media.selection_revision SET use_id=NULL WHERE id=$1', [removed])).rejects.toThrow();
  });
}, 30_000);

test('eight active languages count both tones once and removal frees capacity only after the last tone', async () => {
  await isolated('tones', async (pool, store) => {
    const target = native();
    const heads = new Map<string, string>();
    for (const language of eight) heads.set(language, await selected(store, logo(target, language)));
    const dark = await selected(store, logo(target, 'en', 'dark'));
    expect((await languages(pool, target)).sort()).toEqual([...eight].sort());
    await expect(selected(store, logo(target, 'it'))).rejects.toMatchObject({ code: 'showcase_logo_limit' });
    const lightRemoved = await selected(store, { ...logo(target, 'en'), asset: null, expectedSelection: heads.get('en')! });
    await expect(selected(store, logo(target, 'it'))).rejects.toBeInstanceOf(ShowcaseRefused);
    const darkRemoved = await selected(store, { ...logo(target, 'en', 'dark'), asset: null, expectedSelection: dark });
    await selected(store, logo(target, 'it'));
    // A retained old language must regain capacity; its existence is no exemption.
    await expect(selected(store, { ...logo(target, 'en'), expectedSelection: lightRemoved })).rejects
      .toMatchObject({ code: 'showcase_logo_limit' });
    const japaneseRemoved = await selected(store, { ...logo(target, 'ja'), asset: null, expectedSelection: heads.get('ja')! });
    await selected(store, { ...logo(target, 'en', 'dark'), expectedSelection: darkRemoved });
    expect(await languages(pool, target)).toHaveLength(8);
    expect((await store.showcase.readBatch([target], DEFAULT_MEDIA_CONTEXT)).art.get(target)?.images).toHaveLength(8);
    const chain = (await pool.query(`SELECT predecessor,use_id FROM media.selection_revision WHERE id=$1`, [japaneseRemoved])).rows[0];
    expect(chain).toMatchObject({ predecessor: heads.get('ja'), use_id: null });
    // Cap checking follows CAS: a stale retry reports the retained removal head.
    const stale = await store.showcase.select(admission(), logo(target, 'ja'), inspect);
    expect(stale).toMatchObject({ outcome: 'stale_head', predecessor: japaneseRemoved });
    const failedTarget = native();
    await expect(store.showcase.select(admission(), { ...logo(failedTarget, 'it'), asset: randomUUID() }, inspect)).rejects.toThrow();
    expect(await languages(pool, failedTarget)).toEqual([]);
    expect((await pool.query('SELECT head FROM media.selection_slot WHERE target=$1', [failedTarget])).rows).toEqual([]);
  });
}, 30_000);

test('concurrent additions compete for the remaining language and durable retries do not count twice', async () => {
  await isolated('concurrent', async (pool, store) => {
    const target = native();
    const heads = new Map<string, string>();
    for (const language of eight.slice(0, 7)) heads.set(language, await selected(store, logo(target, language)));
    const requests = ['es', 'it'].map(language => ({ input: logo(target, language), proof: admission() }));
    const outcomes = await Promise.allSettled(requests.map(({ input, proof }) => store.showcase.select(proof, input, inspect)));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'showcase_logo_limit' });
    const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
    const result = (outcomes[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.showcase.select>>>).value;
    expect(await store.showcase.select(requests[winner]!.proof, requests[winner]!.input, inspect))
      .toMatchObject({ id: result.id, replayed: true });
    expect(await languages(pool, target)).toHaveLength(8);
    // The same role still has a CAS winner when changes contend at full capacity.
    const replacements = await Promise.all([1, 2].map(() => store.showcase.select(admission(),
      { ...logo(target, 'en'), expectedSelection: heads.get('en')! }, inspect)));
    expect(replacements.map(result => result.outcome).sort()).toEqual(['stale_head', 'succeeded']);
    expect(await languages(pool, target)).toHaveLength(8);
  });
}, 30_000);

interface Plan {
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
}
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }

test('repeated language churn retains history while active batch and capacity reads visit bounded indexed neighbourhoods', async () => {
  await isolated('history', async (pool, store) => {
    const target = native();
    for (let n = 0; n < 256; n++) {
      const input = logo(target, `x-retired-${n}`);
      const head = await selected(store, input);
      await selected(store, { ...input, asset: null, expectedSelection: head });
    }
    for (const language of eight) await selected(store, logo(target, language));
    expect(await languages(pool, target)).toHaveLength(8);
    expect((await pool.query('SELECT count(*)::int AS n FROM media.selection_slot WHERE target=$1', [target])).rows[0].n).toBe(264);
    expect((await pool.query('SELECT count(*)::int AS n FROM media.selection_revision WHERE target=$1', [target])).rows[0].n).toBe(520);
    const images = (await store.showcase.readBatch([target], DEFAULT_MEDIA_CONTEXT)).art.get(target)!.images;
    expect(images.map(image => image.language).sort()).toEqual([...eight].sort());
    await pool.query('ANALYZE media.selection_slot');
    const planner = await pool.connect();
    try {
      await planner.query('BEGIN; SET LOCAL enable_seqscan=off');
      for (const [sql, args] of [
        [SHOWCASE_LOGO_CAPACITY_SQL, [target, DEFAULT_MEDIA_CONTEXT]],
        [SHOWCASE_BATCH_SQL, [[target], [native(), DEFAULT_MEDIA_CONTEXT]]],
      ] as const) {
        const plan = (await planner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [...args])).rows[0]['QUERY PLAN'][0].Plan as Plan;
        const slots = nodes(plan).filter(node => node['Relation Name'] === 'selection_slot');
        expect(slots.length).toBeGreaterThan(0);
        expect(nodes(plan).map(node => node['Index Name'])).toContain('selection_showcase_active_idx');
        for (const node of slots) {
          // Enumeration uses the active range; fallback visits one exact role key.
          if (!nodes(node).some(probe => probe['Index Name'] === 'selection_showcase_active_idx'))
            expect(nodes(node).some(probe => probe['Index Cond']?.includes('role ='))).toBe(true);
          expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
          expect((node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1)).toBeLessThanOrEqual(16);
        }
      }
    } finally { await planner.query('ROLLBACK'); planner.release(); }
    // Removal keeps the old slot and requires its retained head on later re-add.
    const retained = (await pool.query(`SELECT head FROM media.selection_slot
      WHERE target=$1 AND role='showcase-logo:x-retired-0:light'`, [target])).rows[0].head;
    await expect(selected(store, { ...logo(target, 'x-retired-0'), expectedSelection: retained })).rejects
      .toMatchObject({ code: 'showcase_logo_limit' });
  });
}, 120_000);

test('context fallback resolves each tone through retained removals, empty slots and unreadable selections', async () => {
  await isolated('context', async (pool, store) => {
    const target = native();
    const context = native();
    for (const tone of ['light', 'dark'] as const) await selected(store, logo(target, 'en', tone));
    for (const language of eight.slice(1)) await selected(store, logo(target, language));
    const light = await selected(store, logo(target, 'en', 'light', context));
    await selected(store, { ...logo(target, 'en', 'light', context), expectedSelection: light, asset: null });
    for (const language of eight) await selected(store, logo(target, language, 'dark', context));
    expect(await languages(pool, target, context)).toHaveLength(8);
    await expect(selected(store, logo(target, 'it', 'light', context))).rejects.toMatchObject({ code: 'showcase_logo_limit' });
    await pool.query(`INSERT INTO media.selection_slot(target,context,role,policy)
      VALUES ($1,$2,'showcase-logo:ja:light','showcase-selection-v1')`, [target, context]);
    const read = async () => (await store.showcase.readBatch([target], context)).art.get(target)!.images;
    expect((await read()).filter(image => image.language === 'en')).toHaveLength(1);
    expect((await read()).filter(image => image.language === 'ja')).toHaveLength(1);
    expect((await store.showcase.readBatch([target], DEFAULT_MEDIA_CONTEXT)).art.get(target)!.images).toHaveLength(9);
    const dark = (await read()).find(image => image.language === 'en')!;
    expect(dark).toMatchObject({ tone: 'dark', context });
    await selected(store, { ...logo(target, 'en', 'dark', context), expectedSelection: dark.selection, asset: null });
    await selected(store, logo(target, 'it', 'light', context));
    expect((await read()).some(image => image.language === 'en')).toBe(false);
    // Selected private art remains active and suppresses the public default.
    const upload = await store.reserveUpload(admission(), { asset: null, mediaType: 'image/png',
      byteLength: 32, sha256: 'c'.repeat(64), disclosure: 'private' });
    await store.settleUpload(upload.upload, { status: 'activated', sha256: 'c'.repeat(64),
      byteLength: 32, mediaType: 'image/png', width: 640, height: 480 });
    await store.recordAssetRevision(upload.upload);
    const french = (await read()).find(image => image.language === 'fr' && image.tone === 'dark')!;
    await selected(store, { ...logo(target, 'fr', 'dark', context), asset: upload.asset, expectedSelection: french.selection });
    expect((await read()).some(image => image.language === 'fr' && image.tone === 'dark')).toBe(false);
    expect((await read()).some(image => image.language === 'fr' && image.tone === 'light')).toBe(true);
    expect(await languages(pool, target, context)).toHaveLength(8);
    // A trailer has activity through its URL even though it never has a Use.
    const trailer = { target, context: DEFAULT_MEDIA_CONTEXT, expectedSelection: null,
      url: 'https://youtu.be/dQw4w9WgXcQ' };
    await store.showcase.select(admission(), trailer, inspect);
    expect((await store.showcase.readBatch([target], context)).art.get(target)!.trailer).not.toBeNull();
    await store.showcase.select(admission(), { ...trailer, context, url: null }, inspect);
    expect((await store.showcase.readBatch([target], context)).art.get(target)!.trailer).toBeNull();
  });
}, 30_000);
