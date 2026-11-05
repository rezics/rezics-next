import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  cancelIdentityEpochAdmission,
  stepIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { routeOf } from '../../src/route/route.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { runCommand } from '../../src/command/command.ts';
import { LINKS_PROJECTED } from '../../src/events/contracts/semantic.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import inbound from '../../src/semantic/upsert-inbound-links.sql';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';
import { home, release } from './support/identity-epoch.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  settle,
  type GrowthDatabase,
} from '../support/growth.ts';
import type { IdentityJobRef } from '../../src/semantic/identity-epoch-contract.ts';

type Fixture = Awaited<ReturnType<typeof createIdentityMappingFixture>>;
let route = 0x8000;
async function pair(f: Fixture) {
  const sourceRoute = route;
  route += 32;
  const original = (await f.create('Native mapping source', sourceRoute)).subject.id;
  const survivor = (await f.create('Native mapping target', sourceRoute + 16)).subject.id;
  return { original, survivor };
}
async function begin(f: Fixture) {
  const ids = await pair(f);
  const job = await f.admit({
    kind: 'merge',
    redirected: ids.original,
    survivor: ids.survivor,
    release: release.digest,
  });
  return { ...ids, job };
}
async function assertCustody(f: Fixture, job: IdentityJobRef) {
  const native = await f.nativeRows(job);
  expect(native.head.frontier.after[1]).toBe('complete');
  expect(native.effects.length).toBeGreaterThan(0);
  expect(native.custody).toHaveLength(native.effects.length);
  for (const effect of native.effects) {
    expect(effect.purpose).toBe('mapping');
    expect(effect.same_transaction).toBe(true);
    const parent = native.custody.find((row) => row.effect_key === String(effect.unit));
    expect(parent).toMatchObject({
      native_partition: effect.partition_no,
      native_transaction_id: effect.transaction_id,
      native_epoch: effect.epoch,
      native_position: effect.position,
    });
  }
}

/** Faults surround real SQL/COMMITs. No effect result or native receipt is synthesized. */
async function interrupted<T>(
  pool: Pool,
  arm: RegExp,
  kind: 'lost-commit' | 'rollback' | 'retry',
  operation: () => Promise<T>,
) {
  const originals = new Map<PoolClient, PoolClient['query']>();
  let armed = false,
    fired = false;
  const install = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    const execute = original.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
    client.query = (async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text);
      if (!fired && arm.test(sql)) {
        armed = true;
        if (kind !== 'lost-commit') {
          fired = true;
          // PostgreSQL aborts the actual transaction, including its earlier writes.
          return execute(
            `DO $$ BEGIN RAISE EXCEPTION 'mapping interrupted' USING ERRCODE='${kind === 'retry' ? '40001' : 'P0001'}'; END $$`,
          );
        }
      }
      const result = await execute(...args);
      if (!fired && armed && /^COMMIT\b/i.test(sql.trim())) {
        fired = true;
        throw new Error('mapping committed result lost');
      }
      return result;
    }) as unknown as PoolClient['query'];
  };
  pool.on('acquire', install);
  try {
    return await operation();
  } finally {
    pool.off('acquire', install);
    for (const [client, query] of originals) client.query = query;
    expect(fired).toBe(true);
  }
}

for (const boundary of [
  'INSERT INTO semantic.identity_epoch_mapping_payload',
  'UPDATE semantic.identity_epoch_effect_receipt',
]) {
  test(`native mapping recovers lost committed result at ${boundary}`, async () => {
    const f = await createIdentityMappingFixture({ poolMax: 1 });
    try {
      const input = await begin(f);
      await stepIdentityEpochMapping(f.pool, input.job);
      await expect(
        interrupted(f.pool, new RegExp(boundary), 'lost-commit', () => stepIdentityEpochMapping(f.pool, input.job)),
      ).rejects.toThrow('mapping committed result lost');
      const complete = (await f.drainMapping(input.job, 512)).at(-1)!;
      const before = await f.snapshot([input.original, input.survivor]);
      expect(await stepIdentityEpochMapping(f.pool, input.job)).toEqual(complete);
      expect(await f.snapshot([input.original, input.survivor])).toEqual(before);
      expect(await f.nativeDirectRedirect(input.original)).toBe(input.survivor);
      expect(await identityEpochStore.reconcileStepReceipt(f.pool, complete.receipt)).toEqual(complete);
      await assertCustody(f, input.job);
      await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    } finally {
      await f.close();
    }
  }, 180_000);
}

test('a rolled-back source unit advances neither its redirect nor its effect receipt', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await begin(f);
    await stepIdentityEpochMapping(f.pool, input.job);
    for (let n = 0; n < 32; n++) {
      const rows = await f.nativeRows(input.job);
      if (rows.head.frontier.after[1] === 'source' && rows.head.change.original === input.original) break;
      await stepIdentityEpochMapping(f.pool, input.job);
    }
    const prior = await f.nativeRows(input.job);
    expect(prior.head.change.original).toBe(input.original);
    const before = await f.snapshot([input.original, input.survivor]);
    await expect(
      interrupted(f.pool, /apply_identity_epoch_mapping_source/, 'rollback', () =>
        stepIdentityEpochMapping(f.pool, input.job),
      ),
    ).rejects.toThrow('mapping interrupted');
    const after = await f.nativeRows(input.job);
    expect(after.head).toEqual(prior.head);
    expect(after.effects).toEqual(prior.effects);
    // The durable control intent may commit; the source mutation may not.
    expect((await f.snapshot([input.original, input.survivor])).redirects).toEqual(before.redirects);
    await f.drainMapping(input.job, 512);
    await assertCustody(f, input.job);
  } finally {
    await f.close();
  }
}, 180_000);

test('native serialization retry retains one source revision and exact receipt custody', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await begin(f);
    await stepIdentityEpochMapping(f.pool, input.job);
    for (let n = 0; n < 32; n++) {
      const rows = await f.nativeRows(input.job);
      if (rows.head.frontier.after[1] === 'source' && rows.head.change.original === input.original) break;
      await stepIdentityEpochMapping(f.pool, input.job);
    }
    await interrupted(f.pool, /apply_identity_epoch_mapping_source/, 'retry', () =>
      stepIdentityEpochMapping(f.pool, input.job),
    );
    await f.drainMapping(input.job, 512);
    expect(
      (
        await f.admin.query(
          'SELECT count(*)::integer n FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND kind=$3',
          [routeOf(input.original), input.original, 'merge'],
        )
      ).rows[0]!.n,
    ).toBe(1);
    await assertCustody(f, input.job);
  } finally {
    await f.close();
  }
}, 180_000);

test('cancelled preparation and stale epoch cannot start mapping', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const ids = await pair(f);
    const job = await f.prepare({
      kind: 'merge',
      redirected: ids.original,
      survivor: ids.survivor,
      release: release.digest,
    });
    await cancelIdentityEpochAdmission(f.pool, job);
    for (let n = 0; n < 16; n++) {
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') break;
    }
    expect((await f.readJob(job))!.state).toBe('cancelled');
    await expect(stepIdentityEpochMapping(f.pool, job)).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
    const admitted = await begin(f);
    await expect(
      stepIdentityEpochMapping(f.pool, { ...admitted.job, epoch: admitted.job.epoch + 1n }),
    ).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
    expect(await f.nativeDirectRedirect(admitted.original)).toBeNull();
  } finally {
    await f.close();
  }
}, 180_000);

test('moved input owner cannot produce mapping work or a completion receipt', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await begin(f);
    const partition = home(input.survivor);
    const before = (await f.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partition])).rows[0]!
      .epoch;
    await stepIdentityEpochMapping(f.pool, input.job);
    try {
      await f.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
      await expect(stepIdentityEpochMapping(f.pool, input.job)).rejects.toMatchObject({
        code: 'identity_epoch_unavailable',
      });
      expect(await f.nativeDirectRedirect(input.original)).toBeNull();
      expect((await f.readJob(input.job))!.mapping).toBeNull();
    } finally {
      await f.admin.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, before]);
    }
  } finally {
    await f.close();
  }
}, 180_000);

test('unmerge refuses an ordinary admitted merge that has no published undo and fixed participant custody', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const ids = await pair(f);
    const job = await f.admit({
      kind: 'merge',
      redirected: ids.original,
      survivor: ids.survivor,
      release: release.digest,
    });
    await f.drainMapping(job, 512);
    expect((await f.readJob(job))!.participants['search-canonical-index']).toBeNull();
    await expect(f.publish(job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    // The real pending source cannot be used to admit a contradictory undo job.
    await expect(
      f.admit({
        kind: 'unmerge',
        original: ids.original,
        undoJob: job,
        verificationReceipt: null,
        release: release.digest,
      }),
    ).rejects.toMatchObject({ code: 'identity_epoch_busy' });
  } finally {
    await f.close();
  }
}, 180_000);

async function addIncoming(f: Fixture, subject: string, count: number) {
  const source = (await f.create('Incoming native projection source', route)).subject.id;
  route += 16;
  for (let offset = 0; offset < count; offset += 100) {
    const changes = Array.from({ length: Math.min(100, count - offset) }, () => ({
      subject_id: subject,
      context_id: GLOBAL_CONTEXT,
      suppressed: false,
      property: 'schema:knows',
      source_subject_id: source,
      statement_id: randomUUID(),
      source_revision: 1,
      source_security_revision: 0,
      present: true,
      source_type: 'schema:Person',
      order_key: 'source',
      filter_value: '00000000-0000-0000-0000-000000000000',
    }));
    await runCommand(f.pool, { partition: home(subject) }, async (tx, { transactionId }) => {
      await inbound.run(tx, { route: routeOf(subject)!, transaction_id: transactionId, changes });
      return { value: null, events: [{ type: LINKS_PROJECTED, data: { subjects: [subject] } }] };
    });
  }
}

test('large native incoming degree drains partial units with eight-scalar frontiers and exact links', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const ids = await pair(f);
    await addIncoming(f, ids.original, 101);
    const job = await f.admit({
      kind: 'merge',
      redirected: ids.original,
      survivor: ids.survivor,
      release: release.digest,
    });
    const progress = await f.drainMapping(job, 512);
    for (const step of progress) {
      expect(step.frontier.after.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(step.frontier))).toBeLessThanOrEqual(2048);
      expect(step.work.rows).toBeLessThanOrEqual(100);
    }
    const links = (
      await f.admin.query(
        'SELECT count(*)::integer n FROM semantic.inbound_link WHERE route=$1 AND subject_id=$2 AND present',
        [routeOf(ids.survivor), ids.survivor],
      )
    ).rows[0]!.n;
    expect(links).toBe(101);
    await assertCustody(f, job);
  } finally {
    await f.close();
  }
}, 180_000);

test('actual mapping input work stays fixed as unrelated native population and history grow', async () => {
  const db = await openGrowthDatabase();
  const f = await createIdentityMappingFixture({ poolMax: 1, pool: db.pool, url: db.url });
  let job: IdentityJobRef;
  const prepare = async () => {
    job = (await begin(f)).job;
    await stepIdentityEpochMapping(db.pool, job);
    await settle(db, { analyze: true });
  };
  const operation = async () => {
    const progress = await stepIdentityEpochMapping(db.pool, job);
    expect(progress.work.rows).toBeLessThanOrEqual(2);
    expect(progress.state).toBe('more');
    return progress;
  };
  try {
    const report = await checkGrowth(db, {
      name: 'actual admitted mapping input across unrelated native population and history',
      scales: [64, 512, 4096],
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      async grow(_database: GrowthDatabase, scale, previous) {
        for (let n = previous; n < scale; n++) await f.create(`Unrelated native mapping history ${n}`, 0x7000);
      },
      prepare,
      operation,
      async warmup() {
        await prepare();
        return operation();
      },
    });
    assertGrowthAccessPaths('native mapping input', report.samples, [
      ...new Set(report.samples.flatMap((sample) => Object.keys(sample.relationSizes))),
    ]);
    for (const sample of report.samples)
      for (const backends of sample.backendRepetitions ?? []) expect(new Set(backends).size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
    await db.close();
  }
}, 600_000);

/** Stage old public native effects, then import them through actual export/receive/ACK bootstrap. */
async function nativeGroup(f: Fixture, count: number, incoming = false) {
  const groupRoute = route;
  route += 32;
  const root = (await f.create('Native group terminal', groupRoute)).subject.id;
  const originals = [root];
  for (let n = 1; n < count; n++) {
    const original = (await f.create('Native duplicate original', groupRoute)).subject.id;
    if (incoming && n === 1) await addIncoming(f, original, 1);
    await f.merge(original, root);
    let finished = false;
    for (let page = 0; page < 8; page++) {
      if (!(await moveMergePage(f.pool, original, root))) {
        finished = true;
        break;
      }
    }
    if (!finished) throw new Error('Finite native legacy move did not finish');
    originals.push(original);
  }
  await f.bootstrapHomes(originals);
  return { root, originals };
}

test('native repoint preserves unchanged originals and withdraws the old canonical incoming copy', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const group = await nativeGroup(f, 3, true);
    const original = group.originals[1]!;
    const target = (await f.create('Requested later UUID terminal', route)).subject.id;
    route += 16;
    expect(target > group.root).toBe(true);
    const unchanged = await f.snapshot([group.root, group.originals[2]!]);
    const job = await f.admit({ kind: 'repoint', original, terminal: target, release: release.digest });
    await f.drainMapping(job, 512);
    expect(await f.nativeDirectRedirect(original)).toBe(target);
    expect(await f.nativeDirectRedirect(group.originals[2]!)).toBe(group.root);
    const after = await f.snapshot([group.root, group.originals[2]!]);
    expect(after.revisions).toBe(unchanged.revisions);
    for (const [subject, expected] of [
      [group.root, 0],
      [target, 1],
      [original, 1],
    ] as const) {
      const row = (
        await f.admin.query(
          'SELECT count(*)::integer n FROM semantic.inbound_link WHERE route=$1 AND subject_id=$2 AND present',
          [routeOf(subject), subject],
        )
      ).rows[0]!;
      expect(row.n).toBe(expected);
    }
    await assertCustody(f, job);
  } finally {
    await f.close();
  }
}, 180_000);

test('native merge of a real imported group preserves every original and writes direct redirects', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const group = await nativeGroup(f, 4);
    const target = (await f.create('Explicit survivor', route)).subject.id;
    route += 16;
    const job = await f.admit({ kind: 'merge', redirected: group.root, survivor: target, release: release.digest });
    await f.drainMapping(job, 512);
    for (const original of group.originals) expect(await f.nativeDirectRedirect(original)).toBe(target);
    const native = await f.nativeRows(job);
    const output = native.head.outputs[0];
    const originals = (
      await f.admin.query(
        'SELECT original::text FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND present ORDER BY original',
        [output.home, output.generation],
      )
    ).rows.map((row) => row.original);
    expect(originals).toEqual([...group.originals, target].sort());
    expect(output.count).toBe(5);
    expect(
      (
        await f.admin.query(
          'SELECT release FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1',
          [routeOf(group.root), group.root],
        )
      ).rows[0]!.release,
    ).toBe(release.digest);
    await assertCustody(f, job);
  } finally {
    await f.close();
  }
}, 180_000);

test('a real source mutation racing an admitted hold rolls back and cannot silently change its input', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await begin(f);
    const before = await f.snapshot([input.original, input.survivor]);
    const other = (await f.create('Competing native merge terminal', route)).subject.id;
    route += 16;
    await expect(f.merge(input.original, other)).rejects.toThrow('identity_epoch_unavailable');
    const after = await f.snapshot([input.original, input.survivor]);
    expect(after.redirects).toBe(before.redirects);
    expect(after.revisions).toBe(before.revisions);
    await f.drainMapping(input.job, 512);
    expect(await f.nativeDirectRedirect(input.original)).toBe(input.survivor);
    await assertCustody(f, input.job);
  } finally {
    await f.close();
  }
}, 180_000);

for (const axis of ['group', 'degree'] as const) {
  test(`native mapping fixed raw work is bounded across an independent ${axis} axis`, async () => {
    const db = await openGrowthDatabase();
    const f = await createIdentityMappingFixture({ poolMax: 1, pool: db.pool, url: db.url });
    let job: IdentityJobRef;
    const prepare = async (_db: GrowthDatabase, scale: number) => {
      if (axis === 'group') {
        const group = await nativeGroup(f, scale);
        const target = (await f.create('Independent group axis terminal', route)).subject.id;
        route += 16;
        job = await f.admit({
          kind: 'repoint',
          original: group.originals[1]!,
          terminal: target,
          release: release.digest,
        });
        await stepIdentityEpochMapping(db.pool, job);
      } else {
        const ids = await pair(f);
        await addIncoming(f, ids.original, scale);
        job = await f.admit({
          kind: 'merge',
          redirected: ids.original,
          survivor: ids.survivor,
          release: release.digest,
        });
        for (let step = 0; step < 32; step++) {
          await stepIdentityEpochMapping(db.pool, job);
          const native = await f.nativeRows(job);
          if (native.head.frontier.after[1] === 'links' && native.head.change.original === ids.original) break;
          if (step === 31) throw new Error('Native mapping failed to reach its finite first incoming page');
        }
      }
      await settle(db, { analyze: true });
    };
    const operation = async () => {
      const progress = await stepIdentityEpochMapping(db.pool, job);
      expect(progress.state).toBe('more');
      expect(progress.work.rows).toBeLessThanOrEqual(axis === 'group' ? 2 : 1);
      return progress;
    };
    try {
      const report = await checkGrowth(db, {
        name: `actual native mapping across independent ${axis}`,
        scales: [64, 512, 4096],
        warmups: 1,
        repetitions: 3,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        async grow() {},
        prepare,
        operation,
        async warmup(database, scale) {
          await prepare(database, scale);
          return operation();
        },
      });
      assertGrowthAccessPaths(`native mapping ${axis}`, report.samples, [
        ...new Set(report.samples.flatMap((sample) => Object.keys(sample.relationSizes))),
      ]);
      for (const sample of report.samples)
        for (const backends of sample.backendRepetitions ?? []) expect(new Set(backends).size).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
      await db.close();
    }
  }, 600_000);
}

test('native withdrawn facts retain exact row identities, same-transaction undo custody and owning erasure roles', async () => {
  const { createSubject } = await import('../../src/semantic/subject.ts');
  const { newId } = await import('../../src/route/route.ts');
  const { linkProjection } = await import('../../src/semantic/links.ts');
  const { digest } = await import('./support/identity-epoch.ts');
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const sourceRoute = route;
    route += 48;
    const target = (await f.create('Native source fact target', sourceRoute + 16)).subject.id;
    const survivorKey = randomUUID();
    const survivor = (
      await createSubject(f.pool, {
        actor: await f.actor(),
        target: { route: sourceRoute + 32, id: newId(sourceRoute + 32) },
        item: { type: 'schema:Book', labels: { en: 'Native source fact survivor' } },
        idempotencyKey: survivorKey,
        digest: digest(survivorKey),
        release,
        authorization: await f.authorization('subject:create'),
      })
    ).subject.id;
    const key = randomUUID();
    const original = (
      await createSubject(f.pool, {
        actor: await f.actor(),
        target: { route: sourceRoute, id: newId(sourceRoute) },
        item: {
          type: 'schema:Book',
          labels: { en: 'Native withdrawal source' },
          statements: {
            'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: target } }],
          },
        },
        idempotencyKey: key,
        digest: digest(key),
        release,
        authorization: await f.authorization('subject:create'),
      })
    ).subject.id;
    const relay = linkProjection(f.pool);
    let before: Record<string, unknown>[] = [];
    let projected = false;
    for (let n = 0; n < 64; n++) {
      for (const partition of [home(original), home(target)]) await relay.run(partition);
      before = (
        await f.admin.query(`SELECT * FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2 AND present`, [
          sourceRoute,
          original,
        ])
      ).rows;
      const incoming = (
        await f.admin.query(
          `SELECT 1 FROM semantic.inbound_link
        WHERE route=$1 AND subject_id=$2 AND source_subject_id=$3 AND present LIMIT 1`,
          [routeOf(target)!, target, original],
        )
      ).rowCount;
      if (before.length && incoming) {
        projected = true;
        break;
      }
    }
    expect(projected).toBe(true);
    await f.bootstrapHomes([original, target, survivor]);
    const job = await f.admit({ kind: 'merge', redirected: original, survivor, release: release.digest });
    await f.drainMapping(job, 512);
    const retained = (
      await f.admin.query(
        `SELECT w.row,(w.xmin=e.xmin AND e.xmin=c.xmin) same_transaction
      FROM semantic.identity_epoch_mapping_withdrawal w
      JOIN semantic.identity_epoch_mapping_effect e ON (e.partition_no,e.job_id,e.unit,e.transaction_id)=
        (w.partition_no,w.job_id,w.unit,w.transaction_id)
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
      WHERE w.partition_no=$1 AND w.job_id=$2 AND w.original=$3 ORDER BY w.property,w.target,w.statement,w.filter,w.context`,
        [home(original), job.jobId, original],
      )
    ).rows;
    expect(retained).toHaveLength(before.length);
    for (const row of before) {
      const copy = retained.find(
        (r) =>
          r.row.statement_id === row.statement_id &&
          r.row.context_id === row.context_id &&
          r.row.filter_value === row.filter_value &&
          r.row.target_subject_id === row.target_subject_id,
      );
      expect(copy?.same_transaction).toBe(true);
      for (const field of [
        'subject_id',
        'context_id',
        'property',
        'statement_id',
        'filter_value',
        'target_subject_id',
        'present',
      ])
        expect(copy?.row[field]).toEqual(row[field]);
    }
    const footer = (
      await f.admin.query(
        `SELECT u.*,(u.xmin=e.xmin AND e.xmin=c.xmin) same_transaction,
        (cp.epoch=b.epoch AND cp.position>=b.position) projection_custody
      FROM semantic.identity_epoch_mapping_undo u
      JOIN semantic.identity_epoch_mapping_effect e ON (e.partition_no,e.job_id,e.unit,e.transaction_id)=
        (u.partition_no,u.job_id,u.unit,u.transaction_id)
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
      JOIN semantic.revision fact ON fact.route=$4 AND fact.subject_id=u.original AND fact.revision=u.fact_revision
      JOIN editorial.write_basis b ON b.partition_no=u.partition_no AND b.transaction_id=fact.recorded_transaction_id
      JOIN core.consumer_checkpoint cp ON cp.partition_no=u.partition_no AND cp.consumer='semantic_links'
      WHERE u.partition_no=$1 AND u.job_id=$2 AND u.original=$3`,
        [home(original), job.jobId, original, sourceRoute],
      )
    ).rows;
    expect(footer).toHaveLength(1);
    expect(footer[0]).toMatchObject({
      previous_terminal: original,
      terminal: survivor,
      release: release.digest,
      same_transaction: true,
      fact_projection_complete: true,
      projection_custody: true,
    });
    const actor = (await f.actor()).accountId;
    const stores = (
      await f.admin.query(
        `SELECT DISTINCT store FROM semantic.erasure_locator
      WHERE partition_no=ANY($1::integer[]) AND account_id=$2 AND store LIKE 'identity_epoch_mapping_%'`,
        [[home(original), home(survivor)], actor],
      )
    ).rows.map((r) => r.store);
    for (const suffix of ['head', 'plan', 'effect', 'payload', 'generation', 'fence', 'withdrawal', 'undo'])
      expect(stores).toContain(`identity_epoch_mapping_${suffix}`);
    await assertCustody(f, job);
    await expect(f.publish(job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  } finally {
    await f.close();
  }
}, 180_000);

test('native mapping source function and local effects obey distinct-home RLS under a max-one pool', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  const role = `mapping_home_${randomUUID().replaceAll('-', '')}`;
  const policy = 'mapping_native_home_witness';
  const protectedTables: string[] = [];
  const originals = new Map<PoolClient, PoolClient['query']>();
  let observed = 0;
  const homes = new Set<number>();
  const install = (client: PoolClient) => {
    if (originals.has(client)) return;
    const original = client.query;
    originals.set(client, original);
    const execute = original.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
    client.query = (async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text);
      if (/INSERT INTO semantic.identity_epoch_mapping_effect\(/.test(sql)) {
        const partition = Number((args[1] as unknown[])[0]);
        homes.add(partition);
        await execute(`SET LOCAL ROLE ${role}`);
        await execute(`SELECT set_config('identity_test.home',$1,true)`, [String(partition)]);
        const hidden = (await execute(`SELECT original FROM semantic.identity_epoch_mapping WHERE route/16<>$1`, [
          partition,
        ])) as { rows: unknown[] };
        expect(hidden.rows).toEqual([]);
        observed++;
      }
      return execute(...args);
    }) as PoolClient['query'];
  };
  try {
    const input = await begin(f);
    await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await f.admin.query(`GRANT USAGE ON SCHEMA semantic,core,editorial TO ${role}`);
    await f.admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA semantic,core TO ${role}`);
    await f.admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA semantic,core TO ${role}`);
    await f.admin.query(`GRANT SELECT,INSERT ON editorial.write_basis TO ${role}`);
    const tables = (
      await f.admin.query<{ table_name: string; key: string }>(`SELECT c.relname table_name,
      CASE WHEN EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='partition_no')
      THEN 'partition_no' ELSE 'route / 16' END key FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='semantic' AND c.relkind='r' AND
      (c.relname LIKE 'identity_epoch_%' OR c.relname IN ('subject','revision','redirect','inbound_link','outbound_link',
      'inbound_link_count','outbound_link_count','inbound_link_context_count','outbound_link_context_count',
      'erasure_locator','erasure_source_role','erasure_copy_role','erasure_home','account_agent_subject'))
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('route','partition_no'))
      ORDER BY c.relname`)
    ).rows;
    for (const table of tables) {
      await f.admin.query(`ALTER TABLE semantic.${table.table_name} ENABLE ROW LEVEL SECURITY`);
      protectedTables.push(table.table_name);
      await f.admin.query(`CREATE POLICY ${policy} ON semantic.${table.table_name} TO ${role}
        USING (${table.key}=current_setting('identity_test.home')::integer)
        WITH CHECK (${table.key}=current_setting('identity_test.home')::integer)`);
    }
    f.pool.on('acquire', install);
    await f.drainMapping(input.job, 512);
    expect(observed).toBeGreaterThan(8);
    expect(homes.size).toBeGreaterThan(1);
    expect(await f.nativeDirectRedirect(input.original)).toBe(input.survivor);
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
    await assertCustody(f, input.job);
  } finally {
    f.pool.off('acquire', install);
    for (const [client, original] of originals) client.query = original;
    for (const table of protectedTables) {
      await f.admin.query(`DROP POLICY IF EXISTS ${policy} ON semantic.${table}`);
      await f.admin.query(`ALTER TABLE semantic.${table} DISABLE ROW LEVEL SECURITY`);
    }
    await f.admin.query(`DROP OWNED BY ${role}`).catch(() => {});
    await f.admin.query(`DROP ROLE IF EXISTS ${role}`);
    await f.close();
  }
}, 180_000);

test('repointing a retained group terminal maps the remainder directly to its admitted deterministic root', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const group = await nativeGroup(f, 3);
    const target = (await f.create('Separate native repoint terminal', route)).subject.id;
    route += 16;
    const originalSubjects = (
      await f.admin.query<{ subject_id: string }>(
        `SELECT subject_id FROM semantic.subject WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id`,
        [group.originals],
      )
    ).rows.map((row) => row.subject_id);
    const remainder = group.originals.filter((original) => original !== group.root).sort()[0]!;
    const job = await f.admit({ kind: 'repoint', original: group.root, terminal: target, release: release.digest });
    const progress = await f.drainMapping(job, 512);
    expect(progress.at(-1)?.state).toBe('complete');
    expect(await f.nativeDirectRedirect(group.root)).toBe(target);
    for (const original of group.originals) {
      const expected = original === group.root ? target : original === remainder ? null : remainder;
      expect(await f.nativeDirectRedirect(original)).toBe(expected);
    }
    const currentSubjects = (
      await f.admin.query<{ subject_id: string }>(
        `SELECT subject_id FROM semantic.subject WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id`,
        [group.originals],
      )
    ).rows.map((row) => row.subject_id);
    expect(currentSubjects).toEqual(originalSubjects);
  } finally {
    await f.close();
  }
}, 180_000);

test('missing native link projection custody cannot turn an empty withdrawal into a full undo inventory', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await begin(f);
    await f.drainMapping(input.job, 512);
    const footer = (
      await f.admin.query(
        `SELECT u.fact_projection_complete,fact.revision fact_revision,
      cp.epoch checkpoint_epoch,cp.position checkpoint_position,b.epoch fact_epoch,b.position fact_position
      FROM semantic.identity_epoch_mapping_undo u
      JOIN semantic.revision fact ON fact.route=$1 AND fact.subject_id=u.original AND fact.revision=u.fact_revision
      JOIN editorial.write_basis b ON b.partition_no=u.partition_no AND b.transaction_id=fact.recorded_transaction_id
      LEFT JOIN core.consumer_checkpoint cp ON cp.partition_no=u.partition_no AND cp.consumer='semantic_links'
      WHERE u.partition_no=$2 AND u.job_id=$3 AND u.original=$4`,
        [routeOf(input.original)!, home(input.original), input.job.jobId, input.original],
      )
    ).rows[0];
    expect(footer).toBeDefined();
    expect(footer.fact_projection_complete).toBe(false);
    expect(
      footer.checkpoint_epoch === footer.fact_epoch &&
        footer.checkpoint_position !== null &&
        BigInt(footer.checkpoint_position) >= BigInt(footer.fact_position),
    ).toBe(false);
    await assertCustody(f, input.job);
  } finally {
    await f.close();
  }
}, 180_000);
