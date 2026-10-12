import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { ContentModeration } from '../../content/src/moderation.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { ownerModerationEffects } from '../src/modules/governance/effects.ts';
import { GovernanceStale, type DecisionTargetInput } from '../src/modules/governance/store.ts';
import { uploadDigest } from '../src/modules/media/commands.ts';
import { assetIri, MediaStale, MediaStore, MediaUnavailable, type MediaAdmission,
  type ReserveUploadInput, type UploadReservation } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { mediaRoutes } from '../src/routes/media.ts';

const root = resolve(import.meta.dir, '../../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const image = Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
const differentImage = Buffer.from([71, 73, 70, 56, 57, 97, 2, 0, 1, 0]);
let cluster: PostgresCluster | undefined;
let admin: Pool;
let baseline: Awaited<ReturnType<typeof prepare>>;
const objects = new Map<string, Uint8Array>();

type Actor = { principalId: string; actor: string };
type Asset = { asset: string; representation: string; revision: string; upload: string };

function admission(owner: Actor, input: ReserveUploadInput): MediaAdmission {
  return { admissionId: randomUUID(), principalId: owner.principalId, actingSubject: owner.actor,
    authorityEpoch: '1', requestDigest: uploadDigest(input) };
}

async function actor(pool: Pool): Promise<Actor> {
  const principalId = randomUUID(), actor = assetIri(randomUUID());
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, 'https://account.cover.test', randomUUID()]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await grantFixtureAuthority(pool, { scope: `media:owner:${actor}`, requireDispatch: true,
    representations: [{ principalId, actor, action: 'media.upload', lifetime: 'infinity' }],
    grant: { actor, action: 'media.upload', lifetime: 'infinity' } });
  return { principalId, actor };
}

async function coverInput(pool: Pool, owner: Actor, bytes = image): Promise<ReserveUploadInput> {
  const record = randomUUID(), observation = randomUUID(), externalId = randomUUID();
  const raw = Buffer.from(JSON.stringify({ image: externalId }));
  await pool.query(`INSERT INTO source.record(id,provider,namespace,external_id)
    VALUES ($1,'bangumi','subject',$2)`, [record, externalId]);
  await pool.query(`INSERT INTO source.observation(id,record_id,principal_id,source_revision,media_type,
    retention,raw_bytes,byte_digest,coverage,rights_evidence)
    VALUES ($1,$2,$3,'source-v1','application/json','retained',$4,$5,
      '{"scope":"cover-evidence","complete":false,"omittedFields":[]}',
      '{"basis":"unknown","note":""}')`, [observation, record, owner.principalId, raw, sha(raw)]);
  return { asset: null, mediaType: 'image/gif', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public',
    importedCover: { format: 'media-imported-cover-v1', targetWork: assetIri(randomUUID()),
      source: { record: assetIri(record), component: null, observation: assetIri(observation),
        provider: 'bangumi', namespace: 'subject', externalId, sourceRevision: 'source-v1',
        observationDigest: sha(raw), datasetSnapshotDigest: sha('snapshot'), recordDigest: sha(raw),
        fieldLocator: '/images/common', displayName: 'Bangumi', href: `https://bgm.tv/subject/${externalId}` },
      image: { captureUrl: `https://lain.bgm.tv/pic/cover/${externalId}.gif`, captureDigest: sha(bytes),
        byteLength: bytes.length, mediaType: 'image/gif' }, originalDigest: sha(bytes), holderEvidence: null } };
}

function ordinaryInput(bytes = image): ReserveUploadInput {
  return { asset: null, mediaType: 'image/gif', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public' };
}

async function activate(store: MediaStore, reserved: UploadReservation, bytes: Uint8Array): Promise<Asset> {
  const settled = await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(bytes),
    byteLength: bytes.length, mediaType: 'image/gif', width: 1, height: 1 }, async () => {
    objects.set(`${reserved.objectNamespace}${sha(bytes)}`, bytes.slice());
    return sha(bytes);
  });
  const revision = await store.recordAssetRevision(reserved.upload);
  return { asset: reserved.asset, upload: reserved.upload, representation: settled.representation, revision: revision.revision };
}

async function upload(store: MediaStore, owner: Actor, input: ReserveUploadInput, bytes = image) {
  return activate(store, await store.reserveUpload(admission(owner, input), input), bytes);
}

async function prepare(pool: Pool) {
  const store = new MediaStore(pool, new ContentCore(pool));
  const firstOwner = await actor(pool), secondOwner = await actor(pool);
  const cover = await coverInput(pool, firstOwner);
  const a = await upload(store, firstOwner, cover);
  const b = await upload(store, secondOwner, await coverInput(pool, secondOwner));
  const ordinary = await upload(store, firstOwner, ordinaryInput());
  const different = await upload(store, firstOwner, await coverInput(pool, firstOwner, differentImage), differentImage);
  const staff = await upload(store, secondOwner, await coverInput(pool, secondOwner));
  await store.moderateOriginal('unrelated-staff-restriction', staff.representation,
    (await store.readAsset(staff.asset))!.state, true);
  // Both reservations precede any restriction. Clone them with the baseline;
  // settlement still runs after the restriction in the late-upload case.
  const pendingCover = await store.reserveUpload(admission(firstOwner, cover), cover);
  const userInput = ordinaryInput();
  const pendingUser = await store.reserveUpload(admission(firstOwner, userInput), userInput);
  return { firstOwner, secondOwner, cover, a, b, ordinary, different, staff, pendingCover, pendingUser };
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = boundedPool(cluster.connection);
  await admin.query('CREATE DATABASE imported_cover_copy_template');
  const pool = boundedPool({ ...cluster.connection, database: 'imported_cover_copy_template', max: 8 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'access'))
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    baseline = await prepare(pool);
  } finally { await pool.end(); }
}, 60_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const started = performance.now();
  const name = `cover_copy_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE imported_cover_copy_template`);
  const cloned = performance.now();
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try { await run(fixture(pool)); }
  finally {
    const exercised = performance.now();
    await pool.end(); await admin.query(`DROP DATABASE ${name}`);
    console.info('Imported-cover owner fixture timing (ms)', {
      clone: Math.round(cloned - started), exercise: Math.round(exercised - cloned),
      cleanup: Math.round(performance.now() - exercised),
    });
  }
}

function fixture(pool: Pool) {
  const content = new ContentCore(pool), store = new MediaStore(pool, content);
  const fuseki = new FusekiClient('http://graph.cover.test');
  // The owner test controls only the graph admission adapter; all Media reads,
  // histories, receipts and copy fences below use migrated PostgreSQL storage.
  fuseki.query = async () => ({ boolean: true });
  const environment = { fuseki, objectDirectory: '.temp/imported-cover-copy',
    lineage: { dataEpoch: 'cover-test', routingEpoch: '1' } };
  const dependencies = { environment, access: {}, media: { store, content, objects: (namespace: string) => ({
    put: async (bytes: Uint8Array) => { objects.set(`${namespace}${sha(bytes)}`, bytes.slice()); return sha(bytes); },
    get: async (digest: string) => {
      const bytes = objects.get(`${namespace}${digest}`);
      if (!bytes) throw new MediaUnavailable('test object missing');
      return bytes.slice();
    },
  }) } } as unknown as MainWorkDependencies;
  configureMediaVisibility(dependencies);
  const routes = mediaRoutes(fuseki, dependencies);
  const effects = ownerModerationEffects(new ContentModeration(pool), environment, { pool, core: content });
  return { ...baseline, pool, store, effects,
    bytes: (asset: Asset) => routes.handle(new Request(`http://localhost/v1/media/representations/${asset.representation}/bytes`)),
  };
}

function target(asset: Asset): DecisionTargetInput {
  return { owner: 'media', resource: assetIri(asset.asset), component: 'cover', locator: null,
    scopeKind: 'exact_revision', revision: asset.revision, expectedHead: asset.revision, effect: 'media_delivery' };
}

function decision(copyright = true, ncii = false) {
  return { caseId: randomUUID(), decisionId: randomUUID(), reversesDecisionId: null,
    copyright, ncii, appealUpheld: false, restorationAuthorized: false };
}

async function restrict(f: Awaited<ReturnType<typeof fixture>>, context = decision(), asset = f.a) {
  const plan = await f.effects.plan!(target(asset), 'restrict', context);
  plan.outcome = 'restrict'; plan.ncii = context.ncii;
  return { context, plan, apply: (continuation: string | null = null) =>
    f.effects.apply(`cover-restrict:${context.decisionId}`, 0, target(asset), plan, continuation) };
}

async function restore(f: Awaited<ReturnType<typeof fixture>>, context: ReturnType<typeof decision>, asset = f.a) {
  const next = { ...context, decisionId: randomUUID(), reversesDecisionId: context.decisionId,
    restorationAuthorized: context.copyright, appealUpheld: context.ncii };
  const plan = await f.effects.plan!(target(asset), 'restore', next);
  plan.outcome = 'restore'; plan.ncii = context.ncii;
  return { next, plan, apply: (continuation: string | null = null) =>
    f.effects.apply(`cover-restore:${next.decisionId}`, 0, target(asset), plan, continuation) };
}

async function histories(pool: Pool, assets: readonly Asset[]) {
  return (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM media.asset_state WHERE asset_id=ANY($1::uuid[])',
    [assets.map(asset => asset.asset)])).rows[0]!.n;
}

test('copyright restricts matching imported covers across owners while user bytes and other covers remain deliverable', async () => {
  await isolated(async f => {
    const unchanged = await f.store.readAsset(f.ordinary.asset);
    const { pendingCover, pendingUser } = f;
    const ordinary = ordinaryInput();
    for (const asset of [f.a, f.b, f.ordinary, f.different]) expect((await f.bytes(asset)).status).toBe(200);
    const restriction = await restrict(f);
    expect(restriction.plan.suppression).toMatchObject({ scope: 'imported-cover' });
    expect(await restriction.apply()).toMatchObject({ continuation: null });
    for (const asset of [f.a, f.b]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('suppressed');
      expect((await f.bytes(asset)).status).toBe(404);
    }
    expect(await f.store.readAsset(f.ordinary.asset)).toEqual(unchanged);
    for (const asset of [f.ordinary, f.different]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('none');
      expect((await f.bytes(asset)).status).toBe(200);
    }
    // This owner predicate is the imported-upload admission command's gate.
    expect(await f.store.hasSuppressedImportedCover(f.cover.importedCover!)).toBe(true);
    const admittedUser = await upload(f.store, f.firstOwner, ordinary);
    const settledUser = await activate(f.store, pendingUser, image);
    const settledCover = await activate(f.store, pendingCover, image);
    for (const asset of [admittedUser, settledUser]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('none');
      expect((await f.store.readUpload(asset.upload))?.clearance).toBe('cleared');
      expect((await f.bytes(asset)).status).toBe(200);
    }
    expect((await f.store.readAsset(settledCover.asset))?.moderation).toBe('suppressed');
    expect((await f.store.readUpload(settledCover.upload))?.clearance).toBe('rejected');
    expect((await f.bytes(settledCover)).status).toBe(404);
  });
});

test('an authorized copyright restoration lifts only its saved imported-cover basis and preserves staff suppression', async () => {
  await isolated(async f => {
    const unchanged = await f.store.readAsset(f.ordinary.asset), staff = await f.store.readAsset(f.staff.asset);
    const restriction = await restrict(f);
    await restriction.apply();
    await expect(f.effects.plan!(target(f.a), 'restore', { ...restriction.context,
      decisionId: randomUUID(), reversesDecisionId: restriction.context.decisionId }))
      .rejects.toBeInstanceOf(GovernanceStale);
    const wrongReversal = await f.effects.plan!(target(f.a), 'restore', { ...restriction.context,
      decisionId: randomUUID(), reversesDecisionId: randomUUID(), restorationAuthorized: true });
    wrongReversal.outcome = 'restore';
    await expect(f.effects.apply('wrong-decision-restoration', 0, target(f.a), wrongReversal))
      .rejects.toBeInstanceOf(GovernanceStale);
    const restoration = await restore(f, restriction.context);
    expect(restoration.plan.lift).toMatchObject({ id: restriction.plan.suppression!.id, scope: 'imported-cover' });
    const state = (await f.store.readAsset(f.a.asset))!.state;
    await expect(f.store.moderateOriginal('wrong-scope-lift', f.a.representation, state, false,
      { ...restoration.plan.lift!, scope: 'all' })).rejects.toBeInstanceOf(MediaStale);
    expect(await restoration.apply()).toMatchObject({ continuation: null });
    const count = await histories(f.pool, [f.a, f.b, f.ordinary, f.staff]);
    expect(await restoration.apply()).toMatchObject({ continuation: null });
    expect(await histories(f.pool, [f.a, f.b, f.ordinary, f.staff])).toBe(count);
    for (const asset of [f.a, f.b]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('none');
      expect((await f.bytes(asset)).status).toBe(200);
    }
    expect(await f.store.readAsset(f.ordinary.asset)).toEqual(unchanged);
    expect(await f.store.readAsset(f.staff.asset)).toEqual(staff);
    expect((await f.bytes(f.staff)).status).toBe(404);
    expect((await f.bytes(f.ordinary)).status).toBe(200);
    expect((await f.bytes(f.different)).status).toBe(200);
    expect(await f.store.hasSuppressedImportedCover(f.cover.importedCover!)).toBe(false);
  });
});

test('restoration takes the imported-copy scope from its saved decision even when the current class differs', async () => {
  await isolated(async f => {
    const restriction = await restrict(f);
    await restriction.apply();
    const next = { ...restriction.context, copyright: false, restorationAuthorized: true,
      decisionId: randomUUID(), reversesDecisionId: restriction.context.decisionId };
    const plan = await f.effects.plan!(target(f.a), 'restore', next);
    expect(plan.lift).toMatchObject({ id: restriction.plan.suppression!.id, scope: 'imported-cover' });
    plan.outcome = 'restore';
    await f.effects.apply(`saved-scope-restore:${next.decisionId}`, 0, target(f.a), plan);
    for (const asset of [f.a, f.b, f.ordinary]) expect((await f.bytes(asset)).status).toBe(200);
    expect((await f.bytes(f.staff)).status).toBe(404);
  });
});

test('a copyright restriction written before copy closure remains restorable through its original receipt', async () => {
  await isolated(async f => {
    const oldDecision = randomUUID();
    await f.store.moderateOriginal(`legacy-copyright:${oldDecision}`, f.a.representation,
      (await f.store.readAsset(f.a.asset))!.state, true);
    const context = { ...decision(), restorationAuthorized: true, reversesDecisionId: oldDecision };
    const plan = await f.effects.plan!(target(f.a), 'restore', context);
    expect(plan.lift).toBeUndefined();
    plan.outcome = 'restore';
    await f.effects.apply(`legacy-copyright-restore:${context.decisionId}`, 0, target(f.a), plan);
    for (const asset of [f.a, f.b, f.ordinary]) expect((await f.bytes(asset)).status).toBe(200);
    expect((await f.bytes(f.staff)).status).toBe(404);
  });
});

test('a lost first-batch acknowledgement replays without duplicate histories and continues suppression and restoration past 100', async () => {
  await isolated(async f => {
    const copies: Asset[] = [f.a, f.b];
    for (let index = 0; index < 101; index++) copies.push(await upload(f.store, f.firstOwner, f.cover));
    const restriction = await restrict(f);
    const original = MediaStore.prototype.suppressIdenticalCopies;
    let committed: Awaited<ReturnType<MediaStore['suppressIdenticalCopies']>> | undefined;
    const lost = spyOn(MediaStore.prototype, 'suppressIdenticalCopies').mockImplementation(async function (this: MediaStore, ...args) {
      committed = await original.apply(this, args);
      throw new Error('copy batch acknowledgement lost');
    });
    try { await expect(restriction.apply()).rejects.toThrow('copy batch acknowledgement lost'); }
    finally { lost.mockRestore(); }
    expect(committed!.continuation).not.toBeNull();
    expect(committed!.suppressed).toBeLessThanOrEqual(100);
    expect(committed!.suppressed).toBeGreaterThan(0);
    const beforeReplay = await histories(f.pool, copies);
    const first = await restriction.apply();
    expect(first).toMatchObject({ continuation: committed!.continuation });
    expect(await histories(f.pool, copies)).toBe(beforeReplay);
    // The persisted digest fence already denies the unvisited copy histories.
    const pending = (await f.pool.query<{ id: string }>(`SELECT a.id FROM media.asset a
      JOIN media.asset_state s ON s.id=a.state_head WHERE a.id=ANY($1::uuid[]) AND s.moderation='none'`,
    [copies.map(asset => asset.asset)])).rows;
    expect(pending.length).toBeGreaterThan(0);
    expect((await f.bytes(copies.find(asset => asset.asset === pending[0]!.id)!)).status).toBe(404);
    expect((await f.bytes(f.ordinary)).status).toBe(200);
    await restriction.apply(committed!.continuation);
    for (const asset of copies) expect((await f.store.readAsset(asset.asset))?.moderation).toBe('suppressed');
    const completed = await histories(f.pool, copies);
    await restriction.apply(committed!.continuation);
    expect(await histories(f.pool, copies)).toBe(completed);
    const restoration = await restore(f, restriction.context);
    const lifted = await restoration.apply();
    expect(lifted && lifted.continuation).not.toBeNull();
    const afterFirstLift = await histories(f.pool, copies);
    expect(await restoration.apply()).toEqual(lifted);
    expect(await histories(f.pool, copies)).toBe(afterFirstLift);
    await restoration.apply(lifted && lifted.continuation || null);
    for (const asset of copies) expect((await f.store.readAsset(asset.asset))?.moderation).toBe('none');
    expect((await f.store.readAsset(f.staff.asset))?.moderation).toBe('suppressed');
    expect((await f.bytes(f.ordinary)).status).toBe(200);
  });
}, 60_000);

test('copyright copy closure requires both the authoritative copyright class and an imported-cover target', async () => {
  await isolated(async f => {
    for (const [asset, context] of [[f.ordinary, decision()], [f.a, decision(false)]] as const) {
      const plan = await f.effects.plan!(target(asset), 'restrict', context);
      expect(plan.suppression).toBeUndefined();
    }
    const restriction = await restrict(f, decision(), f.ordinary);
    await restriction.apply();
    expect((await f.store.readAsset(f.ordinary.asset))?.moderation).toBe('suppressed');
    for (const asset of [f.a, f.b]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('none');
      expect((await f.bytes(asset)).status).toBe(200);
    }
  });
});

test('NCII retains its all-copy scope and upheld-appeal restoration across imported and user assets', async () => {
  await isolated(async f => {
    const restriction = await restrict(f, decision(false, true), f.ordinary);
    expect(restriction.plan.suppression).toMatchObject({ scope: 'all' });
    await restriction.apply();
    for (const asset of [f.a, f.b, f.ordinary]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('suppressed');
      expect((await f.bytes(asset)).status).toBe(404);
    }
    await expect(f.effects.plan!(target(f.ordinary), 'restore', { ...restriction.context,
      decisionId: randomUUID(), reversesDecisionId: restriction.context.decisionId, restorationAuthorized: true }))
      .rejects.toBeInstanceOf(GovernanceStale);
    const restoration = await restore(f, restriction.context, f.ordinary);
    expect(restoration.plan.lift).toMatchObject({ scope: 'all' });
    await restoration.apply();
    for (const asset of [f.a, f.b, f.ordinary]) expect((await f.bytes(asset)).status).toBe(200);
    expect((await f.store.readAsset(f.staff.asset))?.moderation).toBe('suppressed');
    expect((await f.bytes(f.different)).status).toBe(200);
  });
});

test('legacy suppression with no explicit scope still fences every matching asset', async () => {
  await isolated(async f => {
    expect(await f.store.suppressIdenticalCopies(sha(image))).toMatchObject({ continuation: null });
    for (const asset of [f.a, f.b, f.ordinary]) {
      expect((await f.store.readAsset(asset.asset))?.moderation).toBe('suppressed');
      expect((await f.bytes(asset)).status).toBe(404);
    }
    expect((await f.bytes(f.different)).status).toBe(200);
  });
});
