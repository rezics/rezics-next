import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { systemClock } from '../../src/clock.ts';
import { currentCommand, runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  beginCollectionSourceOutput,
  appendCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import {
  revalidateNativePublicCollectionOutputHold,
  readNativePublicCollectionOutput,
  lockNativePublicCollectionOutput,
} from '../../src/library/collection-source-native.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { outputCaptureFootprint } from '../../src/semantic/identity-public-output-work.ts';
import stageSQL from '../../src/semantic/identity-public-output-stage.sql';
import transitionInsertSQL from '../../src/semantic/identity-public-output-transition.sql';
import { createPublicIdentityOutputCapture } from '../../src/semantic/identity-public-output-capture.ts';
import {
  createPublicIdentitySourceCapture,
  lockPublicIdentityOutputCaptureDisposition,
} from '../../src/semantic/identity-scoped-public-source.ts';
import { createIdentityScopedObservations } from '../../src/semantic/identity-scoped-observations.ts';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../../src/semantic/public-filter-source.ts';
import {
  readIdentityEpochCutover,
  stepIdentityEpochBootstrapWork,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import {
  sourceRuntimeFixture,
  type SourceRuntimeFixture,
} from '../library/support/canonical-source-runtime-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import type {
  PublicIdentityOutputCapture,
  PublicIdentityOutputWork,
} from '../../src/semantic/identity-public-output-types.ts';
import type { NativePublicOutputBinding } from '../../src/library/native-public-output-contract.ts';
import type { WorkReceipt } from '../../src/library/collection-source.ts';
import type { PoolClient } from 'pg';

let f: SourceRuntimeFixture;
beforeAll(async () => {
  f = await sourceRuntimeFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
// Test funding is explicit and finite on every axis. Production receives no default allowance.
const work = (): PublicIdentityOutputWork => ({
  deadline: Date.now() + 30000,
  allowance: {
    reservationId: randomUUID(),
    remaining: {
      candidateKeys: 1000,
      identityMetadataRows: 20000,
      nativeRows: 40000,
      nativePoints: 40000,
      witnessKeys: 1000,
      statements: 4000,
      bytes: 64 * 1024 * 1024,
      emptySeeks: 4000,
    },
  },
});
const config = () => ({ pool: f.pool, access: f.access, routeKey: testRouteKey(), clock: systemClock });
async function setup(ids: readonly string[], visibility: 'public' | 'private' = 'public') {
  const response = await f.send(f.owner.bearer, 'POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'Canonical output capture',
    visibility,
    rule: { filter: { owner: { presence: true } } },
  });
  expect(response.status).toBe(201);
  const collectionId = (await response.json()).collection.id as string;
  const ref = { route: routeOf(collectionId)!, collectionId, generation: randomUUID() };
  await f.command(collectionId, { begin: ref }, (tx) =>
    beginCollectionSourceOutput(tx, { ...ref, expectedMembers: ids.length }),
  );
  if (ids.length)
    await f.command(collectionId, { append: ref }, (tx) =>
      appendCollectionSourceOutput(tx, { ...ref, after: null, subjectIds: [...ids].sort() }),
    );
  const committed = await f.command(collectionId, { complete: ref }, (tx) => completeCollectionSourceOutput(tx, ref));
  const metadata = await readNativeCollectionMetadata(f.pool, ref, work());
  expect(metadata.metadata?.outputPublication?.transactionId).toBe(committed.transactionId);
  if (!metadata.metadata?.outputPublication) throw new Error('The actual native COMPLETE publication is required');
  const p = metadata.metadata.outputPublication;
  const publication = {
    ...ref,
    activation: { transactionId: p.transactionId, position: p.position, sourceGeneration: p.sourceGeneration },
  };
  const c = config(),
    source = publicFilterSource(c);
  const resolved = await createPublicFilterSourceBinding(f.pool, c.routeKey, c.access).resolve(
    {
      source,
      meaning: { digest: f.originalDigest, release: f.original, type: 'ex:Child' },
      capture: { sort: 'id', size: 20, filterDocument: undefined, text: undefined },
    },
    { deadline: Date.now() + 30000 },
  );
  if (resolved.status !== 'resolved') throw new Error('Real registered public Source definition must resolve');
  for (let step = 0; (await readIdentityEpochCutover(f.pool)).state !== 'ready'; step++) {
    expect(step).toBeLessThan(100000);
    await stepIdentityEpochBootstrapWork(f.pool);
  }
  const request = { captureId: randomUUID(), definition: resolved.definition, publication };
  const producer = createPublicIdentityOutputCapture(c);
  const accepted = await producer.accept(request, work());
  expect(accepted.status).toBe('accepted');
  if (accepted.status !== 'accepted') throw new Error('Real native public output binding did not commit');
  return { producer, request, capture: accepted.capture, ref };
}
async function exhaust(s: Awaited<ReturnType<typeof setup>>) {
  let continuation = '0';
  for (let page = 0; page < 100; page++) {
    const result = await s.producer.capturePage(s.capture, continuation, 1, work());
    expect(['progress', 'exhausted']).toContain(result.status);
    if (result.status !== 'progress' && result.status !== 'exhausted')
      throw new Error('Current native Subject closure is required');
    continuation = result.continuation;
    if (result.status === 'exhausted') return;
  }
  throw new Error('Bounded output driver did not exhaust');
}
async function binding(l: PublicIdentityOutputCapture): Promise<NativePublicOutputBinding> {
  const row = (
    await f.pool.query(
      'SELECT binding FROM semantic.identity_public_output_accepted WHERE partition_no=$1 AND capture_id=$2',
      [l.partition, l.captureId],
    )
  ).rows[0];
  expect(row).toBeDefined();
  return {
    ...row.binding,
    accepted: { ...row.binding.accepted, position: BigInt(row.binding.accepted.position) },
    tuple: {
      ...row.binding.tuple,
      observation: { ...row.binding.tuple.observation, position: BigInt(row.binding.tuple.observation.position) },
    },
  };
}
async function count(
  table: 'accepted' | 'page' | 'seal' | 'fence' | 'disposition' | 'transition',
  l: PublicIdentityOutputCapture,
) {
  return Number(
    (
      await f.pool.query(
        `SELECT count(*)::text AS count FROM semantic.identity_public_output_${table} WHERE partition_no=$1 AND capture_id=$2`,
        [l.partition, l.captureId],
      )
    ).rows[0].count,
  );
}

test('public COMPLETE output capture binds genuine native publication and current Subject canonical closure with atomic receiving disposition and retained uncertain custody while generic public capture and private refusal remain intact', async () => {
  const ids = [await f.createSubject('game'), await f.createSubject('recipe')].sort();
  const s = await setup(ids);
  expect((await s.producer.ready(s.capture, work())).status).toBe('unavailable');
  await exhaust(s);
  const sealed = await s.producer.seal(s.capture, work());
  expect(sealed.status).toBe('sealed');
  const ready = await s.producer.ready(s.capture, work());
  expect(ready.status).toBe('ready');
  const prefix = await s.producer.prefix(s.capture, null, 1, work());
  expect(prefix.status).toBe('ready');
  if (prefix.status === 'ready') {
    expect(prefix.terminals).toEqual([ids[0]!]);
    expect(prefix.after).toBe(ids[0]!);
  }
  const members = await s.producer.membership(s.capture, ids, work());
  expect(members.status).toBe('ready');
  if (members.status === 'ready') expect(members.terminals).toEqual(ids);
  const b = await binding(s.capture);
  expect(b.captureId).toBe(s.capture.captureId);
  expect(b.tuple.publication.transactionId).toBe(s.request.publication.activation.transactionId);
  expect(b.accepted.partition).toBe(partitionOf(s.ref.route));
  const records = (
    await f.pool.query(
      'SELECT body FROM semantic.identity_public_output_page WHERE partition_no=$1 AND capture_id=$2 ORDER BY version',
      [s.capture.partition, s.capture.captureId],
    )
  ).rows;
  expect(records.flatMap((r) => r.body.mappings.map((m: { original: string }) => m.original))).toEqual(ids);
  for (const r of records) {
    expect(r.body.rows.length).toBeLessThanOrEqual(100);
    expect(r.body.receipts).toHaveLength(r.body.cuts.length);
  }
  const reopened = createPublicIdentityOutputCapture(config());
  expect((await reopened.accept(structuredClone(s.request), work())).status).toBe('accepted');
  expect((await reopened.revalidate(JSON.parse(JSON.stringify(s.capture)), work())).status).toBe('ready');
  // Generic factory and opaque receipt remain a different authority.
  expect(createPublicIdentitySourceCapture(config()).capturePage).toBeFunction();
  const forged = await createIdentityScopedObservations(f.pool).register({
    key: { source: { kind: 'public', identity: s.request.definition.source }, scopeId: randomUUID() },
    capture: { kind: 'public', capture: {} as never },
    deadline: Date.now() + 30000,
  });
  expect(forged.status).toBe('unavailable');
  const wrong = await reopened.accept(
    { ...s.request, definition: { ...s.request.definition, dependencyKeys: [] } },
    work(),
  );
  expect(wrong.status).not.toBe('accepted');
  expect(await count('accepted', s.capture)).toBe(1);
}, 120000);

test('wrong binding, foreign Pool, foreign home and foreign authoritative T never supply a disposition', async () => {
  const s = await setup([]);
  const b = await binding(s.capture);
  const selection = {
    captureId: s.capture.captureId,
    holdId: b.holdId,
    bindingDigest: b.bindingDigest,
    disposition: b.accepted,
  };
  await expect(
    lockPublicIdentityOutputCaptureDisposition(f.pool, selection, { ...work(), pool: f.pool, at: {} as never }),
  ).rejects.toThrow('No authorized live command transaction');
  for (const foreign of ['pool', 'time', 'home'] as const) {
    await expect(
      runCommand(
        f.pool,
        {
          partition: foreign === 'home' ? (s.capture.partition + 1) % 4096 : s.capture.partition,
          deadline: Date.now() + 30000,
        },
        async (tx) => {
          const c = currentCommand(tx);
          await lockPublicIdentityOutputCaptureDisposition(tx, selection, {
            ...work(),
            pool: foreign === 'pool' ? ({} as never) : f.pool,
            at: foreign === 'time' ? ({} as never) : c.time,
          });
          throw new Error('Unexpected disposition');
        },
      ),
    ).rejects.toThrow('genuine same Pool/home/T');
  }
  const changed = await s.producer.ready({ ...s.capture, bindingDigest: '0'.repeat(64) }, work());
  expect(changed.status).toBe('unavailable');
  expect(await count('accepted', s.capture)).toBe(1);
  expect(await count('disposition', s.capture)).toBe(0);
});

test('zero output requires a real COMPLETE native publication and seals an empty complete closure', async () => {
  const s = await setup([]);
  await exhaust(s);
  expect((await s.producer.seal(s.capture, work())).status).toBe('sealed');
  const result = await s.producer.prefix(s.capture, null, 100, work());
  expect(result.status).toBe('ready');
  if (result.status === 'ready') {
    expect(result.terminals).toEqual([]);
    expect(result.after).toBeNull();
  }
  const changed = await s.producer.accept(
    {
      ...s.request,
      publication: {
        ...s.request.publication,
        activation: { ...s.request.publication.activation, transactionId: randomUUID() },
      },
    },
    work(),
  );
  expect(changed.status).not.toBe('accepted');
  expect(await count('accepted', s.capture)).toBe(1);
});

test('eligibility loss refuses fresh use while the original binding, pages and custody remain retained', async () => {
  const s = await setup([await f.createSubject('game')]);
  await exhaust(s);
  await s.producer.seal(s.capture, work());
  expect(
    (
      await f.send(f.owner.bearer, 'PATCH', '/v1/collections/' + s.ref.collectionId, {
        revision: 1,
        visibility: 'private',
      })
    ).status,
  ).toBe(200);
  expect((await s.producer.ready(s.capture, work())).status).toBe('changed');
  expect((await s.producer.accept(s.request, work())).status).toBe('changed');
  expect(await count('accepted', s.capture)).toBe(1);
  expect(await count('page', s.capture)).toBeGreaterThan(0);
  expect(await count('seal', s.capture)).toBe(1);
  expect(await count('disposition', s.capture)).toBe(0);
});

test('missing staged disposition and uncertain foreign writer closure refuse release and preserve all obligations', async () => {
  const s = await setup([]);
  await exhaust(s);
  await s.producer.seal(s.capture, work());
  const b = await binding(s.capture);
  await runCommand(f.pool, { partition: s.capture.partition, deadline: Date.now() + 30000 }, async (tx) => {
    const result = await lockPublicIdentityOutputCaptureDisposition(
      tx,
      { captureId: s.capture.captureId, holdId: b.holdId, bindingDigest: b.bindingDigest, disposition: b.accepted },
      { ...work(), pool: f.pool, at: currentCommand(tx).time },
    );
    expect(result.status).toBe('unavailable');
    return {
      value: null,
      events: [{ type: 'com.rezics.semantic.public-output.capture.v1', data: { captureId: s.capture.captureId } }],
    };
  });
  expect((await s.producer.enrollConsumer(s.capture, randomUUID(), work())).status).toBe('enrolled');
  expect(await s.producer.apply(s.capture, work())).toMatchObject({
    status: 'unavailable',
    reason: 'foreign_closure_missing',
  });
  const cancelled = await s.producer.cancel(s.capture, work());
  expect(cancelled).toMatchObject({ status: 'unavailable', reason: 'foreign_closure_missing' });
  expect(await count('fence', s.capture)).toBe(1);
  expect(await count('disposition', s.capture)).toBe(0);
  expect((await s.producer.ready(s.capture, work())).status).toBe('changed');
  expect(await count('accepted', s.capture)).toBe(1);
});

test('a failed atomic staged successor transition rolls native and Semantic rows back; committed replay resolves its original receipt', async () => {
  const s = await setup([]);
  await exhaust(s);
  await s.producer.seal(s.capture, work());
  let injected = false;
  const originals = new Map<PoolClient, PoolClient['query']>();
  const inject = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
      if (!injected && text.startsWith('INSERT INTO semantic.identity_public_output_transition')) {
        injected = true;
        return Promise.reject(new Error('atomic successor fault'));
      }
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', inject);
  try {
    await expect(s.producer.apply(s.capture, work())).rejects.toThrow('atomic successor fault');
  } finally {
    f.pool.off('acquire', inject);
    for (const [client, original] of originals) client.query = original;
  }
  expect(injected, 'The actual native successor branch must execute before the Semantic transition fault').toBe(true);
  expect(await count('disposition', s.capture)).toBe(0);
  expect(await count('transition', s.capture)).toBe(0);
  expect(await count('fence', s.capture)).toBe(0);
  const b = await binding(s.capture);
  await runCommand(f.pool, { partition: s.capture.partition, deadline: Date.now() + 30000 }, async (tx) => {
    expect(
      (
        await revalidateNativePublicCollectionOutputHold(tx, b, {
          ...work(),
          pool: f.pool,
          at: currentCommand(tx).time,
        })
      ).status,
    ).toBe('locked');
    return {
      value: null,
      events: [{ type: 'com.rezics.semantic.public-output.capture.v1', data: { captureId: s.capture.captureId } }],
    };
  });
  const applied = await s.producer.apply(s.capture, work());
  expect(applied.status).toBe('applied');
  const replay = await createPublicIdentityOutputCapture(config()).apply(s.capture, work());
  expect(replay.status).toBe('applied');
  if (applied.status === 'applied' && replay.status === 'applied')
    expect(replay.disposition).toEqual(applied.disposition);
  expect(await count('transition', s.capture)).toBe(1);
});

test('a genuine deferred COMMIT failure retains independent rollback funding and rolls the whole staged disposition back', async () => {
  const s = await setup([]);
  await exhaust(s);
  expect((await s.producer.seal(s.capture, work())).status).toBe('sealed');
  const options = work();
  const controls: string[] = [];
  let staged = false;
  const originals = new Map<PoolClient, PoolClient['query']>();
  const inject = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const config = args[0] as string | { text: string; values?: unknown[] };
      const sql = typeof config === 'string' ? config : config.text;
      if (sql === transitionInsertSQL.sql) {
        staged = true;
        const values = [...(typeof config === 'string' ? (args[1] as unknown[]) : config.values!)];
        // Execute the genuine INSERT, but mismatch its component. Immediate writes succeed;
        // the real deferred native/atomic validators must reject the actual COMMIT.
        values[5] = (BigInt(values[5] as string) + 1n).toString();
        if (typeof config === 'string') args[1] = values;
        else args[0] = { ...config, values };
      }
      if (staged && (sql === 'COMMIT' || sql === 'ROLLBACK')) controls.push(sql);
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    } as PoolClient['query'];
  };
  const attempt = async (funding: PublicIdentityOutputWork) => {
    f.pool.on('acquire', inject);
    try {
      await s.producer.apply(s.capture, funding);
      throw new Error('Expected staged disposition failure');
    } catch (error) {
      return error as Error & { work: WorkReceipt };
    } finally {
      f.pool.off('acquire', inject);
      for (const [client, original] of originals) client.query = original;
      originals.clear();
    }
  };
  const failed = await attempt(options);
  expect(failed.message).toMatch(/public_output/);
  expect(controls).toEqual(['COMMIT', 'ROLLBACK']);
  expect(failed.work.reservationId).toBe(options.allowance.reservationId);
  for (const axis of Object.keys(options.allowance.remaining) as (keyof WorkReceipt['used'])[])
    expect(failed.work.used[axis]).toBeLessThanOrEqual(options.allowance.remaining[axis]);
  expect(failed.work.used.statements).toBeGreaterThan(2);

  // With one fewer statement than the real failed prefix, refuse before COMMIT rather
  // than spending the rollback reservation on COMMIT and masking the failure at cleanup.
  controls.length = 0;
  staged = false;
  const tight = work();
  const refused = await attempt({
    ...tight,
    allowance: {
      ...tight.allowance,
      remaining: { ...tight.allowance.remaining, statements: failed.work.used.statements - 1 },
    },
  });
  expect(refused.work.used.statements).toBeLessThanOrEqual(failed.work.used.statements - 1);
  expect(controls).not.toContain('COMMIT');
  for (const table of ['fence', 'disposition', 'transition'] as const) expect(await count(table, s.capture)).toBe(0);
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::integer AS n FROM semantic.identity_public_output_stage WHERE partition_no=$1 AND capture_id=$2',
        [s.capture.partition, s.capture.captureId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        'SELECT role,consumed_by FROM library.native_public_output_hold WHERE partition_no=$1 AND capture_id=$2',
        [s.capture.partition, s.capture.captureId],
      )
    ).rows,
  ).toEqual([{ role: 'predecessor', consumed_by: null }]);
  expect((await s.producer.apply(s.capture, work())).status).toBe('applied');
}, 120000);

test('a terminal reservation cannot admit unknown SQL appended to production COMMIT', async () => {
  const s = await setup([]);
  await exhaust(s);
  expect((await s.producer.seal(s.capture, work())).status).toBe('sealed');
  let staged = false;
  let injected = false;
  const originals = new Map<PoolClient, PoolClient['query']>();
  const inject = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const config = args[0] as string | { text: string };
      const sql = typeof config === 'string' ? config : config.text;
      if (sql === transitionInsertSQL.sql) staged = true;
      if (staged && !injected && sql === 'COMMIT') {
        injected = true;
        args[0] = typeof config === 'string' ? 'COMMIT; SELECT 1' : { ...config, text: 'COMMIT; SELECT 1' };
      }
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', inject);
  try {
    await expect(s.producer.apply(s.capture, work())).rejects.toThrow('Dependency Unavailable');
  } finally {
    f.pool.off('acquire', inject);
    for (const [client, original] of originals) client.query = original;
  }
  expect(injected).toBe(true);
  for (const table of ['fence', 'disposition', 'transition'] as const) expect(await count(table, s.capture)).toBe(0);
  expect(
    (
      await f.pool.query(
        'SELECT role,consumed_by FROM library.native_public_output_hold WHERE partition_no=$1 AND capture_id=$2',
        [s.capture.partition, s.capture.captureId],
      )
    ).rows,
  ).toEqual([{ role: 'predecessor', consumed_by: null }]);
  expect((await s.producer.apply(s.capture, work())).status).toBe('applied');
}, 120000);

test('a cancelled admitted Subject cut stays fenced and retained without genuine foreign removal custody', async () => {
  const s = await setup([await f.createSubject('game')]);
  await exhaust(s);
  await s.producer.seal(s.capture, work());
  const cuts = await f.pool.query(
    'SELECT * FROM semantic.identity_public_output_subject_cut WHERE capture_partition=$1 AND capture_id=$2',
    [s.capture.partition, s.capture.captureId],
  );
  expect(cuts.rows.length).toBeGreaterThan(0);
  const cancelled = await s.producer.cancel(s.capture, work());
  expect(cancelled).toMatchObject({ status: 'unavailable', reason: 'foreign_closure_missing' });
  expect(await count('fence', s.capture)).toBe(1);
  expect(await count('disposition', s.capture)).toBe(0);
  expect(await count('transition', s.capture)).toBe(0);
  expect((await s.producer.ready(s.capture, work())).status).toBe('changed');
  expect((await s.producer.capturePage(s.capture, '0', 100, work())).status).toBe('changed');
  expect((await s.producer.seal(s.capture, work())).status).toBe('changed');
  expect((await s.producer.enrollConsumer(s.capture, randomUUID(), work())).status).toBe('changed');
  const retained = await f.pool.query(
    'SELECT * FROM semantic.identity_public_output_subject_cut WHERE capture_partition=$1 AND capture_id=$2',
    [s.capture.partition, s.capture.captureId],
  );
  expect(retained.rows).toEqual(cuts.rows);
});

test('original finite remainders cannot borrow funding, dispatch a page or reset its retained continuation', async () => {
  const s = await setup([]);
  const options = work();
  for (const axis of Object.keys(options.allowance.remaining) as (keyof typeof options.allowance.remaining)[]) {
    const tiny = {
      ...options,
      allowance: { ...options.allowance, remaining: { ...options.allowance.remaining, [axis]: 0 } },
    };
    if (axis === 'candidateKeys' || axis === 'witnessKeys') continue;
    await expect(s.producer.capturePage(s.capture, '0', 100, tiny)).rejects.toThrow();
    const progress = (
      await f.pool.query(
        'SELECT version::text,pending FROM semantic.identity_public_output_progress WHERE partition_no=$1 AND capture_id=$2',
        [s.capture.partition, s.capture.captureId],
      )
    ).rows[0];
    expect(progress).toMatchObject({ version: '0', pending: null });
    expect(await count('page', s.capture)).toBe(0);
    expect(await count('accepted', s.capture)).toBe(1);
  }
  const page = await s.producer.capturePage(s.capture, '0', 100, work());
  expect(page.status).toBe('exhausted');
  expect((await s.producer.capturePage(s.capture, '0', 100, work())).status).toBe('changed');
});

test('a private Collection cannot establish a fresh public output binding or replace its accepted publication', async () => {
  const s = await setup([]);
  expect(
    (
      await f.send(f.owner.bearer, 'PATCH', '/v1/collections/' + s.ref.collectionId, {
        revision: 1,
        visibility: 'private',
      })
    ).status,
  ).toBe(200);
  const captureId = randomUUID();
  const result = await s.producer.accept({ ...s.request, captureId }, work());
  expect(result.status).not.toBe('accepted');
  expect(await count('accepted', { ...s.capture, captureId })).toBe(0);
  expect(await count('accepted', s.capture)).toBe(1);
  expect(await count('disposition', s.capture)).toBe(0);
});

test('Exact public COMPLETE output can be bound and held natively for the existing canonical capture producer while unresolved custody survives eligibility changes', async () => {
  const subject = await f.createSubject('game');
  const s = await setup([subject]);
  const b = await binding(s.capture);
  const page = await readNativePublicCollectionOutput(f.pool, b.tuple.identity, { ...work(), after: null, limit: 100 });
  expect(page.status).toBe('ready');
  if (page.status === 'ready') {
    expect(page.rows.map((r) => r.storedSubjectId)).toEqual([subject]);
    expect(page.tuple.publication).toEqual(b.tuple.publication);
  }
  await runCommand(f.pool, { partition: s.capture.partition, deadline: Date.now() + 30000 }, async (tx) => {
    const locked = await lockNativePublicCollectionOutput(tx, b.tuple.identity, {
      ...work(),
      pool: f.pool,
      at: currentCommand(tx).time,
    });
    expect(locked.status).toBe('locked');
    if (locked.status === 'locked') expect(locked.tuple.publication).toEqual(b.tuple.publication);
    return {
      value: null,
      events: [{ type: 'com.rezics.semantic.public-output.capture.v1', data: { captureId: s.capture.captureId } }],
    };
  });
  // Child deletion and owner retirement are independently guarded, before any canonical page is needed.
  for (const sql of [
    'DELETE FROM library.collection_source_output_member WHERE route=$1 AND collection_id=$2 AND generation=$3',
    'DELETE FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2 AND generation=$3',
    'DELETE FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 AND generation=$3',
  ])
    await expect(f.pool.query(sql, [s.ref.route, s.ref.collectionId, s.ref.generation])).rejects.toThrow(
      'native_public_output_retained',
    );
  await expect(
    f.pool.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=$2', [
      s.ref.route,
      s.ref.collectionId,
    ]),
  ).rejects.toThrow('native_public_output_retained');
  expect(
    (
      await f.send(f.owner.bearer, 'PATCH', '/v1/collections/' + s.ref.collectionId, {
        revision: 1,
        visibility: 'private',
      })
    ).status,
  ).toBe(200);
  expect(
    (await readNativePublicCollectionOutput(f.pool, b.tuple.identity, { ...work(), after: null, limit: 100 })).status,
  ).not.toBe('ready');
  const held = await f.pool.query(
    'SELECT role,consumed_by FROM library.native_public_output_hold WHERE partition_no=$1 AND capture_id=$2',
    [s.capture.partition, s.capture.captureId],
  );
  expect(held.rows).toEqual([{ role: 'predecessor', consumed_by: null }]);
  expect(
    (
      await f.pool.query(
        'SELECT count(*)::integer AS n FROM library.collection_source_output_member WHERE route=$1 AND collection_id=$2 AND generation=$3',
        [s.ref.route, s.ref.collectionId, s.ref.generation],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(await count('accepted', s.capture)).toBe(1);
}, 120000);

test('production application persists its immutable selected successor before native transfer and replays both original provenances', async () => {
  const s = await setup([]);
  await exhaust(s);
  const sealed = await s.producer.seal(s.capture, work());
  expect(sealed.status).toBe('sealed');
  const b = await binding(s.capture);
  const before = await f.pool.query(
    'SELECT role,consumed_by FROM library.native_public_output_hold WHERE partition_no=$1 AND capture_id=$2',
    [s.capture.partition, s.capture.captureId],
  );
  expect(before.rows).toEqual([{ role: 'predecessor', consumed_by: null }]);
  const trace: string[] = [];
  const originals = new Map<PoolClient, PoolClient['query']>();
  const observe = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
      for (const name of [
        'semantic.identity_public_output_stage',
        'library.native_public_output_transition',
        'library.native_public_output_hold',
        'semantic.identity_public_output_transition',
      ])
        if (sql.startsWith('INSERT INTO ' + name)) trace.push(name);
      if (sql.startsWith('UPDATE library.native_public_output_hold')) trace.push('consume');
      if (sql.startsWith('UPDATE library.native_public_output_receiving')) trace.push('fence');
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', observe);
  let applied: Awaited<ReturnType<typeof s.producer.apply>>;
  try {
    applied = await s.producer.apply(s.capture, work());
  } finally {
    f.pool.off('acquire', observe);
    for (const [client, original] of originals) client.query = original;
  }
  expect(applied.status).toBe('applied');
  expect(trace).toEqual([
    'semantic.identity_public_output_stage',
    'library.native_public_output_transition',
    'library.native_public_output_hold',
    'consume',
    'fence',
    'semantic.identity_public_output_transition',
  ]);
  const evidence = (
    await f.pool.query(
      `SELECT s.successor_hold_id::text,s.purpose,s.original_receiving_epoch::text,
    s.transaction_id::text,s.native_xid::text,(s.xmin=n.xmin AND s.xmin=t.xmin AND s.xmin=d.xmin AND s.xmin=o.xmin AND s.xmin=k.xmin) AS same_command,
    h.consumed_by::text,k.consumed_by AS successor_consumed
    FROM semantic.identity_public_output_stage s
    JOIN semantic.identity_public_output_disposition d USING(partition_no,capture_id)
    JOIN semantic.identity_public_output_transition t USING(partition_no,capture_id)
    JOIN semantic.identity_epoch_native_commit n ON n.partition_no=s.partition_no AND n.transaction_id=s.transaction_id
    JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
    JOIN library.native_public_output_hold h ON h.partition_no=s.partition_no AND h.hold_id=s.hold_id
    JOIN library.native_public_output_hold k ON k.partition_no=s.partition_no AND k.hold_id=s.successor_hold_id
    WHERE s.partition_no=$1 AND s.capture_id=$2`,
      [s.capture.partition, s.capture.captureId],
    )
  ).rows[0];
  expect(evidence.same_command).toBe(true);
  expect(evidence.purpose).toBe('identity-public-output-applied');
  expect(evidence.original_receiving_epoch).toBe(b.tuple.identity.receivingEpoch);
  expect(evidence.successor_hold_id).not.toBe(b.holdId);
  expect(evidence.consumed_by).toBe(evidence.transaction_id);
  expect(evidence.successor_consumed).toBeNull();
  const replay = await createPublicIdentityOutputCapture(config()).apply(s.capture, work());
  expect(replay.status).toBe('applied');
  if (applied.status === 'applied' && replay.status === 'applied')
    expect(replay.disposition).toEqual(applied.disposition);
  expect((await s.producer.cancel(s.capture, work())).status).toBe('unavailable');
  await expect(
    f.pool.query('UPDATE library.native_public_output_hold SET consumed_by=$3 WHERE partition_no=$1 AND hold_id=$2', [
      s.capture.partition,
      evidence.successor_hold_id,
      evidence.transaction_id,
    ]),
  ).rejects.toThrow();
  await expect(
    f.pool.query(
      'UPDATE semantic.identity_public_output_stage SET successor_hold_id=$3 WHERE partition_no=$1 AND capture_id=$2',
      [s.capture.partition, s.capture.captureId, randomUUID()],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        'SELECT hold_id::text FROM library.native_public_output_hold WHERE partition_no=$1 AND capture_id=$2 AND consumed_by IS NULL',
        [s.capture.partition, s.capture.captureId],
      )
    ).rows,
  ).toEqual([{ hold_id: evidence.successor_hold_id }]);
}, 120000);

test('zero-output cancellation uses a genuine next epoch fence and committed release replay without consuming a successor', async () => {
  const s = await setup([]);
  await exhaust(s);
  const b = await binding(s.capture);
  let cancelled = await s.producer.cancel(s.capture, work());
  for (let i = 0; i < 4 && cancelled.status === 'pending'; i++) cancelled = await s.producer.cancel(s.capture, work());
  expect(cancelled.status).toBe('cancelled');
  const replay = await createPublicIdentityOutputCapture(config()).cancel(s.capture, work());
  expect(replay.status).toBe('cancelled');
  if (cancelled.status === 'cancelled' && replay.status === 'cancelled')
    expect(replay.disposition).toEqual(cancelled.disposition);
  const state = (
    await f.pool.query(
      `SELECT s.purpose,s.cancellation_epoch::text,s.successor_hold_id,
    g.receiving_epoch::text AS gate_epoch,r.receiving_epoch::text AS native_epoch,g.enrolled_count::text,
    h.consumed_by::text,s.transaction_id::text
    FROM semantic.identity_public_output_stage s JOIN semantic.identity_public_output_gate g USING(partition_no,capture_id)
    JOIN library.native_public_output_receiving r USING(partition_no,capture_id)
    JOIN library.native_public_output_hold h ON h.partition_no=s.partition_no AND h.hold_id=s.hold_id
    WHERE s.partition_no=$1 AND s.capture_id=$2`,
      [s.capture.partition, s.capture.captureId],
    )
  ).rows[0];
  const next = (BigInt(b.tuple.identity.receivingEpoch) + 1n).toString();
  expect(state).toMatchObject({
    purpose: 'identity-public-output-cancelled',
    cancellation_epoch: next,
    gate_epoch: next,
    native_epoch: next,
    enrolled_count: '0',
    successor_hold_id: null,
  });
  expect(state.consumed_by).toBe(state.transaction_id);
  expect((await s.producer.seal(s.capture, work())).status).toBe('changed');
  expect((await s.producer.enrollConsumer(s.capture, randomUUID(), work())).status).toBe('changed');
  expect(await count('transition', s.capture)).toBe(1);
}, 120000);

test('enrollment is positively fenced and an enrolled unknown writer cannot become an empty closure', async () => {
  const s = await setup([]);
  await exhaust(s);
  await s.producer.seal(s.capture, work());
  const consumer = randomUUID();
  expect((await s.producer.enrollConsumer(s.capture, consumer, work())).status).toBe('enrolled');
  expect((await s.producer.enrollConsumer(s.capture, consumer, work())).status).toBe('enrolled');
  expect(await s.producer.cancel(s.capture, work())).toMatchObject({
    status: 'unavailable',
    reason: 'foreign_closure_missing',
  });
  const gate = (
    await f.pool.query(
      'SELECT state,original_epoch::text,receiving_epoch::text,enrolled_count::text FROM semantic.identity_public_output_gate WHERE partition_no=$1 AND capture_id=$2',
      [s.capture.partition, s.capture.captureId],
    )
  ).rows[0];
  expect(gate).toEqual({ state: 'cancelled', original_epoch: '1', receiving_epoch: '2', enrolled_count: '1' });
  await expect(
    f.pool.query('DELETE FROM semantic.identity_public_output_consumer WHERE partition_no=$1 AND capture_id=$2', [
      s.capture.partition,
      s.capture.captureId,
    ]),
  ).rejects.toThrow();
  await expect(
    f.pool.query(
      'UPDATE semantic.identity_public_output_gate SET enrolled_count=0 WHERE partition_no=$1 AND capture_id=$2',
      [s.capture.partition, s.capture.captureId],
    ),
  ).rejects.toThrow();
  expect(await count('disposition', s.capture)).toBe(0);
  expect((await s.producer.enrollConsumer(s.capture, randomUUID(), work())).status).toBe('changed');
}, 120000);

test('all eight finite axes settle a late failed child without a new allowance and unknown SQL cannot dispatch', async () => {
  const options = work();
  const parent = new NativeCollectionWork(options.allowance, options.deadline);
  const used = {
    candidateKeys: 2,
    identityMetadataRows: 3,
    nativeRows: 16,
    nativePoints: 2,
    witnessKeys: 1,
    statements: 2,
    bytes: 512,
    emptySeeks: 2,
  };
  const error = new Error('late child failure');
  await expect(
    parent.compose(async (allowance) => {
      expect(allowance.reservationId).toBe(options.allowance.reservationId);
      const child = new NativeCollectionWork(allowance, options.deadline);
      const admitted = child.reserve(used);
      admitted.dispatch();
      admitted.settle();
      Object.defineProperty(error, 'work', { value: child.receipt(), configurable: true });
      throw error;
    }),
  ).rejects.toThrow('late child failure');
  expect(parent.receipt()).toEqual({ reservationId: options.allowance.reservationId, used });
  expect(() => parent.reserve(used)).toThrow('late child failure');
  const ledger = new NativeCollectionWork(work().allowance, options.deadline);
  const oneQuery = ledger.reserve(used);
  expect(() => oneQuery.query(async () => null)).toThrow('Source query was not uniquely dispatched');
  oneQuery.dispatch();
  expect(await oneQuery.query(async () => 'one admitted query')).toBe('one admitted query');
  expect(() => oneQuery.query(async () => null)).toThrow('Source query was not uniquely dispatched');
  oneQuery.settle();
  expect(() => oneQuery.query(async () => null)).toThrow('Source query was not uniquely dispatched');
  expect(outputCaptureFootprint(ledger, 'SELECT unknown_custody_authority()', [])).toBeUndefined();
  expect(() => ledger.reserve(undefined)).toThrow();
  for (const sql of [stageSQL.sql, transitionInsertSQL.sql]) {
    const footprint = outputCaptureFootprint(ledger, sql, []);
    expect(footprint).toBeDefined();
    expect(footprint!.statements).toBe(3);
    expect(footprint!.nativeRows).toBeGreaterThan(100);
    expect(footprint!.emptySeeks).toBe(3);
  }
});
