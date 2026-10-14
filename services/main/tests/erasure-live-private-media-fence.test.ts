import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { boundedPool, CONNECTION_BOUNDS } from '../src/infrastructure/pg-pool.ts';
import { applyContentErasure } from '../src/modules/erasure/content.ts';
import { activateUploadedBytes, type MediaDependencies } from '../src/modules/media/commands.ts';
import { assetIri, MediaFenced, MediaInvalid, MediaMissing, MediaStale, MediaStore,
  type MediaAdmission, type ReserveUploadInput } from '../src/modules/media/store.ts';
import { withPreservationFence } from '../src/modules/public-report/preservation.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

// Real owner transactions and locks; graph admission and object I/O are controlled
// adapters. Physical inventory/deletion is qualified separately by the Media owner.
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
const verdict = { status: 'activated' as const, sha256: sha(image), byteLength: image.length,
  mediaType: 'image/gif' as const, width: 1, height: 1 };
let cluster: PostgresCluster | undefined;
let admin: Pool;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function blocked(pool: Pool, sqlFragment: string) {
  const until = Date.now() + 1_500;
  do {
    const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND position($1 in query)>0 AND cardinality(pg_blocking_pids(pid))>0`, [sqlFragment]);
    if (waiting.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  throw new Error(`Owner transaction did not block at ${sqlFragment}`);
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query('CREATE DATABASE media_fence_template');
  const template = new Pool({ ...cluster.connection, database: 'media_fence_template' });
  try {
    await migrateContent(template);
    await template.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY,target_resource text NOT NULL,reason text NOT NULL,released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL,operation_id text NOT NULL,material_ref text NOT NULL,reason text NOT NULL,
        PRIMARY KEY (hold_id,operation_id,material_ref))`);
  } finally { await template.end(); }
}, 30_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

async function fixture(run: (f: Awaited<ReturnType<typeof mediaFixture>>) => Promise<void>, imported = false,
  idleTimeout = CONNECTION_BOUNDS.idleInTransactionSessionTimeout) {
  const name = `media_fence_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE media_fence_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 },
    { ...CONNECTION_BOUNDS, idleInTransactionSessionTimeout: idleTimeout });
  // Owners share this isolated database fixture, but retain the separate
  // pools that production uses for cross-owner preservation fences.
  const preservationPool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try { await run(await mediaFixture(pool, preservationPool, imported)); }
  finally {
    await Promise.all([pool.end(), preservationPool.end()]);
    // Each scenario restores an isolated copy of the same prepared owner cut.
    // Dispose it here so earlier scenarios do not retain physical database copies.
    await admin.query(`DROP DATABASE ${name}`);
  }
}

async function mediaFixture(pool: Pool, preservationPool: Pool, imported: boolean) {
  const content = new ContentCore(pool);
  const store = new MediaStore(pool, content);
  const principal = randomUUID(), owner = assetIri(randomUUID());
  const admission = (actingSubject = owner): MediaAdmission => ({ admissionId: randomUUID(), principalId: principal,
    actingSubject, authorityEpoch: '1', requestDigest: sha(randomUUID()) });
  let importedCover: ReserveUploadInput['importedCover'];
  if (imported) {
    const record = randomUUID(), observation = randomUUID(), raw = Buffer.from('retained source cover evidence');
    await pool.query(`INSERT INTO source.record(id,provider,namespace,external_id)
      VALUES ($1,'bangumi','subject','pinned-cover')`, [record]);
    await pool.query(`INSERT INTO source.observation(id,record_id,principal_id,source_revision,media_type,
      retention,raw_bytes,byte_digest,coverage,rights_evidence)
      VALUES ($1,$2,$3,'source-v1','application/json','retained',$4,$5,
        '{"scope":"cover-evidence","complete":false,"omittedFields":[]}',
        '{"basis":"unknown","note":""}')`,
    [observation, record, principal, raw, sha(raw)]);
    importedCover = { format: 'media-imported-cover-v1', targetWork: assetIri(randomUUID()),
      source: { record: assetIri(record), component: null, observation: assetIri(observation), provider: 'bangumi',
        namespace: 'subject', externalId: 'pinned-cover', sourceRevision: 'source-v1', observationDigest: sha(raw),
        datasetSnapshotDigest: sha('snapshot'), recordDigest: sha('record'), fieldLocator: '/image',
        displayName: 'Bangumi', href: 'https://bgm.tv/subject/1' },
      image: { captureUrl: 'https://lain.bgm.tv/image.gif', captureDigest: sha(image), byteLength: image.length,
        mediaType: 'image/gif' }, originalDigest: sha(image), holderEvidence: null };
  }
  const reserved = await store.reserveUpload(admission(), { asset: null, mediaType: 'image/gif',
    byteLength: image.length, sha256: sha(image), disclosure: 'private', importedCover });
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  let writes = 0;
  let onPut: ((namespace: string, signal?: AbortSignal) => Promise<void>) | undefined;
  let onVerify: typeof onPut;
  let onDelete: ((namespace: string, signal?: AbortSignal) => Promise<void>) | undefined;
  const media: MediaDependencies = { store, content, objects: namespace => {
    const waitFor = async (pending: Promise<void> | undefined, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (pending && signal) await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
      else await pending;
      signal?.throwIfAborted();
    };
    const putTracked = async (bytes: Uint8Array, signal?: AbortSignal, onCreated?: (digest: string) => void) => {
      await waitFor(onPut?.(namespace, signal), signal);
      writes++;
      const digest = sha(bytes);
      const key = `${namespace}sha256/${digest}`;
      const created = !objects.has(key);
      if (created) {
        objects.set(key, bytes.slice());
        onCreated?.(digest);
      }
      await waitFor(onVerify?.(namespace, signal), signal);
      return { digest, created };
    };
    return {
      put: async (bytes: Uint8Array, signal?: AbortSignal) => (await putTracked(bytes, signal)).digest,
      putTracked,
      get: async (digest: string, _maximum?: number, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const bytes = objects.get(`${namespace}sha256/${digest}`);
        if (!bytes) throw new Error('object is absent');
        return bytes.slice();
      },
      deleteAndVerifyAbsent: async (digest: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        await onDelete?.(namespace, signal);
        const key = `${namespace}sha256/${digest}`;
        objects.delete(key);
        deleted.push(key);
        expect(objects.has(key)).toBe(false);
      },
    } as ImmutableObjects;
  } };
  const env = { fuseki: new class extends FusekiClient {
    constructor() { super('http://media-fence.invalid'); }
    override async query() { return { boolean: true }; }
  }(), lineage: { dataEpoch: randomUUID(), routingEpoch: '0' }, objectDirectory: '.temp/media-fence' } as WorkActivationEnvironment;
  const account = { verify: async () => ({ issuer: 'https://accounts.invalid', subject: owner }) };
  const access = { activePrincipalId: async () => principal } as unknown as Parameters<typeof activateUploadedBytes>[3];
  const request = new Request('http://media-fence.invalid', { headers: { authorization: 'Bearer owner' } });
  const transfer = (intake: Parameters<typeof activateUploadedBytes>[6] = image) =>
    activateUploadedBytes(env, media, account, access, request, reserved.upload, intake);
  const persistFor = (reservation: typeof reserved): NonNullable<Parameters<MediaStore['settleUpload']>[2]> =>
    async (signal, onFailure) => {
      const quarantine = media.objects(`${reservation.quarantineKey}/`);
      const stored = await quarantine.putTracked!(image, signal, digest =>
        onFailure({ digest, cleanup: cleanupSignal => quarantine.deleteAndVerifyAbsent!(digest, cleanupSignal) }));
      const staged = await quarantine.get(stored.digest, undefined, signal);
      const original = media.objects(reservation.objectNamespace);
      return (await original.putTracked!(staged, signal, digest =>
        onFailure({ digest, cleanup: cleanupSignal => original.deleteAndVerifyAbsent!(digest, cleanupSignal) }))).digest;
    };
  const persist = persistFor(reserved);
  const reserveReplacement = () => store.reserveUpload(admission(), { asset: reserved.asset,
    mediaType: 'image/gif', byteLength: image.length, sha256: sha(image), disclosure: 'private' });
  const change = async (lifecycle: 'active' | 'deleted' | 'erased', actingSubject = owner) => {
    const state = await store.readAsset(reserved.asset);
    if (!state) throw new Error('asset state is absent');
    const proof = admission(actingSubject);
    const input = { asset: reserved.asset, expectedState: state.state, disclosure: 'private' as const, lifecycle };
    if (lifecycle !== 'erased') return store.changeState(proof, input);
    const guarded = await withPreservationFence(preservationPool, assetIri(reserved.asset), proof.admissionId,
      fence => store.changeState(proof, input, fence));
    if (guarded.held) throw new MediaFenced('media is retained under a preservation hold');
    return guarded.value;
  };
  const erase = async () => {
    const result = await change('erased');
    expect(result.outcome).toBe('succeeded');
    objects.clear();
    return result;
  };
  return { pool, preservationPool, content, store, reserved, objects, deleted, principal, owner, transfer, persist, persistFor,
    reserveReplacement, change, erase,
    writes: () => writes, onPut: (callback: typeof onPut) => { onPut = callback; },
    onVerify: (callback: typeof onVerify) => { onVerify = callback; },
    onDelete: (callback: typeof onDelete) => { onDelete = callback; } };
}

test('erase wins a slow upload: neither quarantine nor original persistence starts', async () => {
  await fixture(async f => {
    const intake = barrier(), started = barrier();
    const transfer = f.transfer(async maximum => {
      expect(maximum).toBe(image.length);
      started.release();
      await intake.promise;
      return image;
    });
    const outcome = transfer.then(() => null, error => error as unknown);
    try {
      await started.promise;
      await f.erase();
    } finally { intake.release(); }
    expect(await outcome).toBeInstanceOf(MediaStale);
    expect(f.writes()).toBe(0);
    expect(f.objects.size).toBe(0);
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
  });
});

test('persistence wins the asset lock: fenced erase waits for both object writes and activation', async () => {
  await fixture(async f => {
    const started = barrier(), release = barrier();
    f.onPut(async namespace => {
      if (namespace !== f.reserved.objectNamespace) return;
      started.release();
      await release.promise;
    });
    const activation = f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    await started.promise;
    expect(f.objects.size).toBe(1);
    const erasure = f.erase();
    try { await blocked(f.pool, 'FOR UPDATE OF a'); }
    finally { release.release(); }
    expect((await activation).status).toBe('activated');
    await erasure;
    expect(f.writes()).toBe(2);
    expect(f.objects.size).toBe(0);
    expect((await f.pool.query('SELECT availability FROM media.representation')).rows)
      .toEqual([{ availability: 'erased' }]);
    const replay = await f.store.settleUpload(f.reserved.upload, verdict, async () => {
      throw new Error('terminal replay must not persist');
    });
    expect(replay.replayed).toBe(true);
    await expect(f.transfer()).rejects.toBeInstanceOf(MediaStale);
    expect(f.writes()).toBe(2);
  });
});

test('concurrent settlement persists once and returns the same original on replay', async () => {
  await fixture(async f => {
    const started = barrier(), release = barrier();
    let calls = 0;
    const persist: typeof f.persist = async (signal, onFailure) => {
      calls++; started.release(); await release.promise; return f.persist(signal, onFailure);
    };
    const first = f.store.settleUpload(f.reserved.upload, verdict, persist);
    await started.promise;
    const second = f.store.settleUpload(f.reserved.upload, verdict, persist);
    try { await blocked(f.pool, 'pg_advisory_xact_lock'); }
    finally { release.release(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(a.representation).toBe(b.representation);
    expect(calls).toBe(1);
    expect(f.writes()).toBe(2);
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(1);
  });
});

test('stale reservation epochs refuse transfers even after the asset is reactivated', async () => {
  await fixture(async f => {
    await f.change('deleted');
    await f.change('active');
    await expect(f.transfer()).rejects.toBeInstanceOf(MediaStale);
    await expect(f.store.settleUpload(f.reserved.upload, { status: 'rejected', reason: 'format-rejected' }))
      .rejects.toBeInstanceOf(MediaStale);
    expect(f.writes()).toBe(0);
    expect((await f.store.readAsset(f.reserved.asset))!.erasureEpoch).toBe('1');
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
  });
});

test('foreign upload principal is refused before intake and persistence', async () => {
  await fixture(async f => {
    const reader = spyOn(f.store, 'readUpload').mockImplementation(async () => ({
      id: f.reserved.upload, asset: f.reserved.asset, status: 'reserved', mediaType: 'image/gif',
      byteLength: image.length, sha256: sha(image), quarantineKey: f.reserved.quarantineKey,
      objectNamespace: f.reserved.objectNamespace, owner: f.owner, expired: false,
      representation: null, principal: randomUUID(), reason: null, clearance: null, clearanceReason: null,
    }));
    let intake = 0;
    try { await expect(f.transfer(async () => { intake++; return image; })).rejects.toBeInstanceOf(MediaMissing); }
    finally { reader.mockRestore(); }
    expect(intake).toBe(0);
    expect(f.writes()).toBe(0);
  });
});

test('held and foreign media retain bytes and refuse erasure through the existing owner policy', async () => {
  await fixture(async f => {
    await f.transfer();
    const before = await f.store.readAsset(f.reserved.asset);
    await expect(f.change('erased', assetIri(randomUUID()))).rejects.toBeInstanceOf(MediaMissing);
    const hold = randomUUID();
    await f.pool.query(`INSERT INTO access.governance_preservation_hold(id,target_resource,reason)
      VALUES ($1,$2,'active case')`, [hold, assetIri(f.reserved.asset)]);
    await expect(f.erase()).rejects.toBeInstanceOf(MediaFenced);
    expect(await f.store.readAsset(f.reserved.asset)).toEqual(before);
    expect(f.objects.size).toBe(2);
    expect((await f.pool.query('SELECT availability FROM media.representation')).rows)
      .toEqual([{ availability: 'available' }]);
    expect((await f.pool.query('SELECT 1 FROM access.governance_erasure_postponement WHERE hold_id=$1',
      [hold])).rowCount).toBe(1);
  });
});

test('partial object persistence rolls back activation and can recover or be fenced by erase', async () => {
  for (const recover of [true, false]) await fixture(async f => {
    f.onPut(async namespace => {
      if (namespace === f.reserved.objectNamespace) throw new Error('original store unavailable');
    });
    await expect(f.transfer()).rejects.toThrow('original store unavailable');
    expect(f.objects.size).toBe(0);
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM content.receipt WHERE operation_id=$1',
      [`media-activate:${f.reserved.upload}`])).rowCount).toBe(0);
    f.onPut(undefined);
    if (recover) {
      expect((await f.transfer()).status).toBe('activated');
      expect(f.objects.size).toBe(2);
    }
    await f.erase();
    const writes = f.writes();
    await expect(f.transfer()).rejects.toBeInstanceOf(MediaStale);
    expect(f.writes()).toBe(writes);
    expect(f.objects.size).toBe(0);
  });
});

test('bounded request pools abort stalled quarantine and original writes while erasure still waits', async () => {
  for (const stage of ['quarantine', 'original']) await fixture(async f => {
    const started = barrier(), release = barrier();
    let writeSignal: AbortSignal | undefined;
    let cleanupHeldLock = false;
    f.onVerify(async (namespace, signal) => {
      const stalled = stage === 'original' ? namespace === f.reserved.objectNamespace
        : namespace === `${f.reserved.quarantineKey}/`;
      if (!stalled) return;
      writeSignal = signal;
      started.release();
      await release.promise;
    });
    f.onDelete(async (_namespace, signal) => {
      expect(writeSignal?.aborted).toBe(true);
      expect(signal?.aborted).toBe(false);
      const waiting = await admin.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=$1 AND position('FOR UPDATE OF a' in query)>0
          AND cardinality(pg_blocking_pids(pid))>0`, [f.pool.options.database]);
      cleanupHeldLock ||= Boolean(waiting.rowCount);
    });
    const outcome = f.transfer().then(() => null, error => error as unknown);
    await started.promise;
    expect(writeSignal).toBeInstanceOf(AbortSignal);
    let erased = false;
    const erasure = f.erase().then(result => { erased = true; return result; });
    try {
      await blocked(f.pool, 'FOR UPDATE OF a');
      expect(erased).toBe(false);
      expect(await outcome).toBeInstanceOf(Error);
      expect(cleanupHeldLock).toBe(true);
      expect(f.objects.size).toBe(0);
      expect(f.deleted).toContain(`${f.reserved.quarantineKey}/sha256/${sha(image)}`);
      if (stage === 'original') expect(f.deleted).toContain(`${f.reserved.objectNamespace}sha256/${sha(image)}`);
      await erasure;
      const writes = f.writes();
      release.release();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(f.writes()).toBe(writes);
      expect(f.objects.size).toBe(0);
      expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
      expect((await f.store.readAsset(f.reserved.asset))!.lifecycle).toBe('erased');
    } finally {
      release.release();
      await erasure;
    }
  }, false, '2s');
}, 10_000);

test('both exact objects are cleaned when activation SQL fails after persistence', async () => {
  await fixture(async f => {
    await f.pool.query(`CREATE FUNCTION media.refuse_original() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'original activation unavailable'; END $$;
      CREATE TRIGGER refuse_original BEFORE INSERT ON media.representation
      FOR EACH ROW EXECUTE FUNCTION media.refuse_original()`);
    await expect(f.transfer()).rejects.toThrow('original activation unavailable');
    expect(f.objects.size).toBe(0);
    expect(f.deleted.sort()).toEqual([`${f.reserved.quarantineKey}/sha256/${sha(image)}`,
      `${f.reserved.objectNamespace}sha256/${sha(image)}`].sort());
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
    await f.erase();
  });
});

test('a replacement failing after PUT keeps the same-digest original referenced by an earlier representation', async () => {
  for (const restoreMissingOriginal of [false, true]) await fixture(async f => {
    const first = await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    const originalKey = `${f.reserved.objectNamespace}sha256/${sha(image)}`;
    const earlierQuarantineKey = `${f.reserved.quarantineKey}/sha256/${sha(image)}`;
    if (restoreMissingOriginal) f.objects.delete(originalKey);
    const replacement = await f.reserveReplacement();
    const replacementQuarantineKey = `${replacement.quarantineKey}/sha256/${sha(image)}`;
    let originalWasPersisted = false;
    f.onVerify(async namespace => {
      if (namespace !== f.reserved.objectNamespace) return;
      originalWasPersisted = true;
      expect(f.objects.get(originalKey)).toEqual(image);
      expect(f.objects.get(replacementQuarantineKey)).toEqual(image);
    });
    await f.pool.query(`CREATE FUNCTION media.refuse_replacement() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'replacement activation unavailable'; END $$;
      CREATE TRIGGER refuse_replacement BEFORE INSERT ON media.representation
      FOR EACH ROW EXECUTE FUNCTION media.refuse_replacement()`);
    await expect(f.store.settleUpload(replacement.upload, verdict, f.persistFor(replacement)))
      .rejects.toThrow('replacement activation unavailable');
    expect(originalWasPersisted).toBe(true);
    expect(f.objects.get(originalKey)).toEqual(image);
    expect(f.objects.get(earlierQuarantineKey)).toEqual(image);
    expect(f.deleted).not.toContain(originalKey);
    expect(f.deleted).not.toContain(earlierQuarantineKey);
    expect((await f.pool.query('SELECT id,availability FROM media.representation')).rows)
      .toEqual([{ id: first.representation, availability: 'available' }]);
    expect((await f.store.readUpload(replacement.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM content.receipt WHERE operation_id=$1',
      [`media-activate:${replacement.upload}`])).rowCount).toBe(0);
  });
});

test('a lost COMMIT acknowledgement keeps activated objects and retry replays the durable activation', async () => {
  await fixture(async f => {
    let lostAcknowledgement = false;
    const uncertainPool = new Proxy(f.pool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(target, property) {
          if (property === 'query') return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.query, target, args);
            if (args[0] === 'COMMIT' && !lostAcknowledgement) {
              lostAcknowledgement = true;
              throw new Error('connection lost before COMMIT acknowledgement');
            }
            return result;
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new MediaStore(uncertainPool, f.content);
    const activated = await store.settleUpload(f.reserved.upload, verdict, f.persist);
    expect(lostAcknowledgement).toBe(true);
    expect(activated.status).toBe('activated');
    expect(f.objects.get(`${f.reserved.objectNamespace}sha256/${sha(image)}`)).toEqual(image);
    expect(f.objects.get(`${f.reserved.quarantineKey}/sha256/${sha(image)}`)).toEqual(image);
    expect(f.deleted).toEqual([]);
    expect((await f.pool.query('SELECT id,availability FROM media.representation')).rows)
      .toEqual([{ id: activated.representation, availability: 'available' }]);
    expect((await f.pool.query('SELECT 1 FROM content.receipt WHERE operation_id=$1',
      [`media-activate:${f.reserved.upload}`])).rowCount).toBe(1);
    const replayed = await f.store.settleUpload(f.reserved.upload, verdict, async () => {
      throw new Error('committed activation replay must not persist');
    });
    expect(replayed.status).toBe('activated');
    expect(replayed.replayed).toBe(true);
    expect(replayed.representation).toBe(activated.representation);
    expect(f.writes()).toBe(2);
    expect(f.deleted).toEqual([]);
  });
});

test('failed verified cleanup preserves the persistence error and erasure removes the orphan', async () => {
  await fixture(async f => {
    f.onPut(async namespace => {
      if (namespace === f.reserved.objectNamespace) throw new Error('original store unavailable');
    });
    f.onDelete(async () => { throw new Error('verified cleanup unavailable'); });
    await expect(f.transfer()).rejects.toThrow('original store unavailable');
    expect(f.objects.size).toBe(1);
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
    await f.erase();
    expect(f.objects.size).toBe(0);
  });
});

test('a lost persistence transaction cannot publish and cleans both exact objects', async () => {
  await fixture(async f => {
    const persist: typeof f.persist = async (signal, onFailure) => {
      const digest = await f.persist(signal, onFailure);
      const terminated = await admin.query(`SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'
          AND backend_xid IS NOT NULL`, [f.pool.options.database]);
      expect(terminated.rows).toEqual([{ terminated: true }]);
      return digest;
    };
    await expect(f.store.settleUpload(f.reserved.upload, verdict, persist)).rejects.toBeInstanceOf(Error);
    expect(f.objects.size).toBe(0);
    expect(f.deleted).toHaveLength(2);
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
    await f.erase();
  });
});

test('S3 persistence deadline cancels the PUT and its uncached verification read', async () => {
  for (const stalledMethod of ['PUT', 'GET']) {
    const started = barrier(), release = barrier();
    const data = new Map<string, Uint8Array>();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === 'DELETE') {
        data.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'HEAD') return new Response(null, { status: data.has(key) ? 200 : 404 });
      if (request.method === 'PUT') data.set(key, new Uint8Array(await request.arrayBuffer()));
      if (request.method === stalledMethod) {
        started.release();
        await release.promise;
      }
      if (request.method === 'PUT') return new Response(null, { status: 200 });
      const bytes = data.get(key);
      return bytes ? new Response(Buffer.from(bytes)) : new Response(null, { status: 404 });
    } });
    const objects = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
      bucket: 'rezics-media', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
      prefix: 'media/quarantine/' });
    const controller = new AbortController();
    const outcome = objects.put(image, controller.signal).then(() => null, error => error as unknown);
    try {
      await started.promise;
      controller.abort(new Error('persistence deadline'));
      expect(await outcome).toBeInstanceOf(ObjectUnavailable);
      await objects.deleteAndVerifyAbsent(sha(image), AbortSignal.timeout(1_000));
      expect(data.size).toBe(0);
      release.release();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(data.size).toBe(0);
    } finally {
      release.release();
      await server.stop(true);
    }
  }
});

test('activation requires fenced persistence and refuses undeclared or mismatched object bytes', async () => {
  await fixture(async f => {
    await expect(f.store.settleUpload(f.reserved.upload, verdict)).rejects.toBeInstanceOf(MediaInvalid);
    let calls = 0;
    const wrong = async () => { calls++; return sha('wrong original'); };
    await expect(f.store.settleUpload(f.reserved.upload, { ...verdict, byteLength: image.length + 1 }, wrong))
      .rejects.toBeInstanceOf(MediaInvalid);
    expect(calls).toBe(0);
    await expect(f.store.settleUpload(f.reserved.upload, verdict, wrong)).rejects.toBeInstanceOf(MediaInvalid);
    expect(calls).toBe(1);
    expect((await f.store.readUpload(f.reserved.upload))!.status).toBe('reserved');
    expect((await f.pool.query('SELECT 1 FROM media.representation')).rowCount).toBe(0);
  });
});

test('terminal erase and changed epochs refuse pending and historical asset-revision repair', async () => {
  for (const recorded of [true, false]) await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    if (recorded) await f.store.recordAssetRevision(f.reserved.upload);
    const before = (await f.pool.query('SELECT id FROM content.revision ORDER BY id')).rows;
    await f.erase();
    await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
    await expect(f.transfer()).rejects.toBeInstanceOf(MediaStale);
    expect((await f.pool.query('SELECT id FROM content.revision ORDER BY id')).rows).toEqual(before);
    expect(f.objects.size).toBe(0);
  });
  await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    await f.change('deleted');
    await f.change('active');
    await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
    expect((await f.pool.query('SELECT 1 FROM content.revision')).rowCount).toBe(0);
  });
});

test('erase wins a delayed Content save: asset-revision recording cannot republish', async () => {
  await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    const save = f.content.saveDraft.bind(f.content), started = barrier(), release = barrier();
    const writer = spyOn(f.content, 'saveDraft').mockImplementation(async (command, transactionFence) => {
      started.release(); await release.promise; return save(command, transactionFence);
    });
    const recording = f.store.recordAssetRevision(f.reserved.upload);
    const outcome = recording.then(() => null, error => error as unknown);
    try {
      await started.promise;
      await f.erase();
    } finally { release.release(); }
    try {
      expect(await outcome).toBeInstanceOf(MediaStale);
      await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
      expect(writer).toHaveBeenCalledTimes(1);
      expect((await f.pool.query('SELECT id FROM content.revision')).rows).toEqual([]);
      expect((await f.pool.query('SELECT id FROM content.variant')).rows).toEqual([]);
      for (const table of ['receipt', 'outbox']) {
        expect((await f.pool.query(`SELECT 1 FROM content.${table} WHERE operation_id=$1`,
          [`media-asset-revision:${f.reserved.upload}`])).rowCount).toBe(0);
      }
    } finally { writer.mockRestore(); }
  });
});

test('erase wins a delayed Content receipt replay: historical recording must re-enter the asset fence', async () => {
  await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    const initial = await f.store.recordAssetRevision(f.reserved.upload);
    const before = (await f.pool.query('SELECT id FROM content.revision ORDER BY id')).rows;
    expect(before).toEqual([{ id: initial.revision }]);
    const save = f.content.saveDraft.bind(f.content), started = barrier(), release = barrier();
    const writer = spyOn(f.content, 'saveDraft').mockImplementation(async (command, transactionFence) => {
      started.release(); await release.promise; return save(command, transactionFence);
    });
    const recording = f.store.recordAssetRevision(f.reserved.upload);
    const outcome = recording.then(() => null, error => error as unknown);
    try {
      await started.promise;
      await f.erase();
    } finally { release.release(); }
    try {
      expect(await outcome).toBeInstanceOf(MediaStale);
      expect(writer).toHaveBeenCalledTimes(1);
      expect((await f.pool.query('SELECT id FROM content.revision ORDER BY id')).rows).toEqual(before);
      expect((await f.pool.query('SELECT 1 FROM content.receipt WHERE operation_id=$1',
        [`media-asset-revision:${f.reserved.upload}`])).rowCount).toBe(1);
      expect((await f.pool.query('SELECT 1 FROM content.outbox WHERE operation_id=$1',
        [`media-asset-revision:${f.reserved.upload}`])).rowCount).toBe(1);
      expect(f.objects.size).toBe(0);
    } finally { writer.mockRestore(); }
  });
});

test('Content save wins the asset fence: erase waits and recording completes before erasure', async () => {
  await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    const save = f.content.saveDraft.bind(f.content), started = barrier(), release = barrier();
    let fencePid = 0;
    const writer = spyOn(f.content, 'saveDraft').mockImplementation((command, transactionFence) =>
      save(command, async client => {
        expect(transactionFence).toBeDefined();
        await transactionFence!(client);
        fencePid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        started.release();
        await release.promise;
      }));
    // Keep erasure waiting after Content commits so the separate projection
    // repair can finish too. Assert Content's own client blocks it below.
    const keeperPool = boundedPool({ ...cluster!.connection, database: f.pool.options.database, max: 1 });
    const keeper = await keeperPool.connect();
    await keeper.query('BEGIN');
    const recording = f.store.recordAssetRevision(f.reserved.upload);
    const recorded = recording.then(value => value, error => error as unknown);
    let erasure: ReturnType<typeof f.erase> | undefined;
    try {
      await started.promise;
      await keeper.query('SELECT id FROM media.asset WHERE id=$1 FOR SHARE', [f.reserved.asset]);
      erasure = f.erase();
      await blocked(f.pool, 'FOR UPDATE OF a');
      expect((await f.pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND position('FOR UPDATE OF a' in query)>0
          AND $1=ANY(pg_blocking_pids(pid))`, [fencePid])).rowCount).toBe(1);
      release.release();
      const result = await recording;
      expect(result.replayed).toBe(false);
      expect((await f.pool.query('SELECT id,availability FROM content.revision')).rows)
        .toEqual([{ id: result.revision, availability: 'available' }]);
      expect((await f.store.recordAssetRevision(f.reserved.upload)).replayed).toBe(true);
      await keeper.query('COMMIT');
      await erasure;
      await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
      expect(f.objects.size).toBe(0);
    } finally {
      release.release();
      await keeper.query('ROLLBACK');
      keeper.release();
      await keeperPool.end();
      await recorded;
      await erasure;
      writer.mockRestore();
    }
  });
});

test('an erased exact original refuses a delayed Content save while its asset remains active', async () => {
  await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    const save = f.content.saveDraft.bind(f.content), started = barrier(), release = barrier();
    const writer = spyOn(f.content, 'saveDraft').mockImplementation(async (command, transactionFence) => {
      started.release(); await release.promise; return save(command, transactionFence);
    });
    const recording = f.store.recordAssetRevision(f.reserved.upload);
    const outcome = recording.then(() => null, error => error as unknown);
    try {
      await started.promise;
      await f.pool.query("UPDATE media.representation SET availability='erased' WHERE upload_id=$1",
        [f.reserved.upload]);
    } finally { release.release(); }
    try {
      expect(await outcome).toBeInstanceOf(MediaStale);
      expect((await f.store.readAsset(f.reserved.asset))!.lifecycle).toBe('active');
      expect((await f.pool.query('SELECT 1 FROM content.revision')).rowCount).toBe(0);
      expect((await f.pool.query('SELECT 1 FROM content.receipt WHERE operation_id=$1',
        [`media-asset-revision:${f.reserved.upload}`])).rowCount).toBe(0);
    } finally { writer.mockRestore(); }
  });
});

test('erasure between a Content save or receipt replay and projection repair refuses recording', async () => {
  for (const replay of [false, true]) await fixture(async f => {
    await f.store.settleUpload(f.reserved.upload, verdict, f.persist);
    if (replay) await f.store.recordAssetRevision(f.reserved.upload);
    const repair = f.store.repairImportedCoverProjection.bind(f.store);
    const projection = spyOn(f.store, 'repairImportedCoverProjection').mockImplementation(async revision => {
      await f.erase();
      return repair(revision);
    });
    try {
      await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
      expect(projection).toHaveBeenCalledTimes(1);
      expect((await f.pool.query('SELECT 1 FROM media.imported_cover_revision')).rowCount).toBe(0);
    } finally { projection.mockRestore(); }
  }, true);
});

test('late imported-cover repair cannot restore a lookup after asset or exact Content erasure', async () => {
  for (const exact of [false, true]) await fixture(async f => {
    const activated = await f.transfer();
    expect(activated.revision).not.toBeNull();
    const revision = activated.revision!;
    expect((await f.pool.query('SELECT 1 FROM media.imported_cover_revision')).rowCount).toBe(1);
    if (exact) await applyContentErasure(f.pool, { preservationAccess: f.preservationPool, erasureId: randomUUID(),
      erasureEpoch: '1', resourceId: assetIri(f.reserved.asset), revisionIds: [revision] });
    else await f.erase();
    expect(await f.store.repairImportedCoverProjection(revision)).toBe(false);
    expect((await f.pool.query('SELECT 1 FROM media.imported_cover_revision')).rowCount).toBe(0);
    await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
  }, true);
});

test('reactivating an asset cannot repair an imported cover from a stale upload epoch', async () => {
  await fixture(async f => {
    const activated = await f.transfer();
    expect(activated.revision).not.toBeNull();
    await f.change('deleted');
    await f.change('active');
    expect(await f.store.repairImportedCoverProjection(activated.revision!)).toBe(false);
    await expect(f.store.recordAssetRevision(f.reserved.upload)).rejects.toBeInstanceOf(MediaStale);
    expect((await f.pool.query('SELECT 1 FROM media.imported_cover_revision')).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM content.revision')).rowCount).toBe(1);
  }, true);
});
