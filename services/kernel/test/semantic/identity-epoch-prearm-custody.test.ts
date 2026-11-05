import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import {
  readIdentityPrearmCustodyPage,
  verifyIdentityPrearmCustodyCut,
  type IdentityPrearmCustodyCut,
} from '../../src/semantic/identity-epoch-prearm-custody.ts';
import type { IdentityFrontier, IdentityJobRef, NativeStepWork } from '../../src/semantic/identity-epoch-contract.ts';
import { identityEpochStore, identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import {
  readIdentityPrearmTicket,
  type IdentityPrearmTicketData,
} from '../../src/semantic/identity-epoch-prearm-contract.ts';
import { releaseIdentityPrearmHome } from '../../src/semantic/identity-epoch-prearm.ts';
import {
  stepIdentityEpochAdmission,
  cancelIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { createIdentityScopedObservations } from '../../src/semantic/identity-scoped-observations.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceFrontier,
  type NativeSourceIdentity,
} from '../../src/library/native-source-custody.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  cutoverFixture,
  libraryCutoverInput,
  nativeCutoverCoordinator,
  withoutOwner,
} from './support/identity-epoch-cutover.ts';
import { digest, release } from './support/identity-epoch.ts';

const allowance = (): NativeStepWork => ({
  rows: 100,
  points: 1000,
  statements: 100,
  bytes: 1024 * 1024,
  engineRequests: 0,
});
const context = () => ({ deadline: Date.now() + 5000 });

// These cases use the existing native fixtures and real producers. They are authored for
// controller proof; this worker runs only Kernel typing, without inventing Source custody.
test('The exact native admitted prearm directory remains boundedly readable and revalidatable after native release without inventing consumer closure or reopening released gates', async () => {
  const f = await cutoverFixture();
  try {
    const original = (await f.create('Retained ticket original', 0x8910)).id;
    const terminal = (await f.create('Retained ticket survivor', 0x8920)).id;
    const library = await libraryCutoverInput(f, [original]);
    const sourceWork = () => ({
      ...context(),
      allowance: {
        reservationId: randomUUID(),
        remaining: {
          candidateKeys: 100,
          identityMetadataRows: 0,
          nativeRows: 100000,
          nativePoints: 1000,
          witnessKeys: 100,
          statements: 100,
          bytes: 1024 * 1024,
          emptySeeks: 100,
        },
      },
    });
    const route = routeOf(library.collection.id)!;
    const metadata = await readNativeCollectionMetadata(
      f.pool,
      { route, collectionId: library.collection.id },
      sourceWork(),
    );
    if (!metadata.metadata) throw new Error('Missing native Collection metadata');
    const owner = (await f.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
      .rows[0];
    const identity: NativeSourceIdentity = {
      route,
      collectionId: library.collection.id,
      accountId: library.account,
      incarnation: metadata.metadata.incarnation,
      generation: metadata.metadata.sourceGeneration,
      scope: 'curated',
      ownerEpoch: owner.epoch,
      receivingEpoch: '1',
      effectKey: randomUUID(),
    };
    const custody = createNativeLibrarySourceCustody({ pool: f.pool });
    let capturedFrontier: NativeSourceFrontier | null = null;
    for (let page = 0; page < 100; page++) {
      const captured = await custody.capturePage({ ...sourceWork(), identity, frontier: capturedFrontier, limit: 1 });
      if (captured.status !== 'pending') throw new Error('Native capture unavailable');
      capturedFrontier = captured.frontier;
      if (capturedFrontier.driver === 'done') break;
    }
    if (!capturedFrontier || capturedFrontier.driver !== 'done') throw new Error('Native capture did not exhaust');
    const captured = await custody.finishCapture({ ...sourceWork(), identity, frontier: capturedFrontier });
    if (captured.status !== 'complete') throw new Error('Missing native capture receipt');
    const observations = createIdentityScopedObservations(f.pool);
    const key = { source: { kind: 'library' as const, identity }, scopeId: randomUUID() };
    let registered = false;
    for (let step = 0; step < 100; step++) {
      const result = await observations.register({
        key,
        capture: {
          kind: 'library',
          capture: captured.capture,
          frontier: capturedFrontier,
          allowance: sourceWork().allowance,
        },
        ...context(),
      });
      if (result.status === 'registered') {
        registered = true;
        break;
      }
      expect(result.status).toBe('pending');
    }
    expect(registered).toBe(true);
    const actor = await f.actor();
    const commandKey = randomUUID();
    const job = await identityEpochStore().prepareAdmission(
      f.pool,
      {
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
        ...context(),
      },
      {
        intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: {
            actorAccountId: actor.accountId,
            kind: 'subject.merge',
            key: commandKey,
            digest: digest(commandKey),
          },
        },
      },
    );
    for (let step = 0; step < 100; step++)
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
    const nativePages = (
      await f.pool.query(
        `SELECT p.page_id,p.partition_no,p.transaction_id,c.epoch,c.position
      FROM semantic.identity_epoch_prearm_page p JOIN semantic.identity_epoch_native_commit c
      ON c.partition_no=p.partition_no AND c.transaction_id=p.transaction_id
      WHERE p.job_id=$1 AND p.original IS NOT NULL ORDER BY p.partition_no,p.generation,p.sequence`,
        [job.jobId],
      )
    ).rows;
    expect(nativePages.length).toBeGreaterThan(0);
    const originalTickets: IdentityPrearmTicketData[] = [];
    for (const page of nativePages) {
      const ticket = await readIdentityPrearmTicket(f.pool, {
        job,
        ordinal: 0,
        pageId: page.page_id,
        directory: {
          partition: page.partition_no,
          epoch: page.epoch,
          position: BigInt(page.position),
          transactionId: page.transaction_id,
        },
      });
      if (!ticket) throw new Error('Missing original active native ticket');
      originalTickets.push(ticket);
    }
    expect(
      (
        await readIdentityPrearmCustodyPage(
          f.pool,
          { job: { jobId: randomUUID(), epoch: 1n }, after: null, limit: 1, allowance: allowance() },
          context(),
        )
      ).status,
    ).toBe('unavailable');
    expect(
      (await readIdentityPrearmCustodyPage(f.pool, { job, after: null, limit: 1, allowance: allowance() }, context()))
        .status,
    ).toBe('unavailable');
    await (
      await nativeCutoverCoordinator()
    )(f.pool, job);
    expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('published');
    for (let step = 0; step < 100; step++) {
      await stepIdentityEpochAdmission(f.pool, job);
      const pending = await f.pool.query(
        `SELECT resource_home FROM semantic.identity_epoch_admission_plan
        WHERE partition_no=$1 AND job_id=$2 AND NOT released LIMIT 1`,
        [identityJobPartition(job), job.jobId],
      );
      if (!pending.rowCount) break;
    }
    const before = await f.snapshot([original, terminal]);
    const retained = (
      await f.pool.query(
        `SELECT partition_no,generation,release_transaction_id FROM semantic.identity_epoch_prearm_directory
      WHERE job_id=$1 ORDER BY partition_no,generation`,
        [job.jobId],
      )
    ).rows;
    expect(retained.every((d) => d.release_transaction_id !== null)).toBe(true);
    let after: IdentityFrontier | null = null,
      cut: IdentityPrearmCustodyCut | null = null;
    const tickets: IdentityPrearmTicketData[] = [];
    for (let page = 0; page < 100; page++) {
      const result = await readIdentityPrearmCustodyPage(
        f.pool,
        { job, after, limit: 1, allowance: allowance() },
        context(),
      );
      if (result.status === 'unavailable') throw new Error(result.reason);
      tickets.push(...result.tickets);
      expect(result.work.rows).toBeLessThanOrEqual(100);
      expect(result.frontier.after.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(result.frontier))).toBeLessThanOrEqual(2048);
      if (page === 0 && result.status === 'progress') {
        expect(
          (
            await readIdentityPrearmCustodyPage(
              f.pool,
              {
                job,
                limit: 1,
                allowance: allowance(),
                after: { ...result.frontier, segment: result.frontier.segment + 1 },
              },
              context(),
            )
          ).status,
        ).toBe('unavailable');
      }
      if (after)
        expect(
          result.frontier.segment > after.segment ||
            (result.frontier.segment === after.segment &&
              BigInt(result.frontier.after[0] as string) > BigInt(after.after[0] as string)),
        ).toBe(true);
      // Serialization preserves the scalar continuation; caller-created positions do not authenticate.
      after = JSON.parse(JSON.stringify(result.frontier));
      if (result.status === 'complete') {
        cut = result.cut;
        break;
      }
      expect('cut' in result).toBe(false);
    }
    if (!cut) throw new Error('Retained native inventory failed to exhaust');
    expect(tickets.sort((a, b) => a.locator.pageId.localeCompare(b.locator.pageId))).toEqual(
      originalTickets.sort((a, b) => a.locator.pageId.localeCompare(b.locator.pageId)),
    );
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('current');
    expect(await readIdentityPrearmTicket(f.pool, originalTickets[0]!.locator)).toBeNull();
    expect(
      (await verifyIdentityPrearmCustodyCut(f.pool, { ...job, epoch: job.epoch + 1n }, cut, context())).status,
    ).toBe('unavailable');
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, {} as IdentityPrearmCustodyCut, context())).status).toBe(
      'unavailable',
    );
    const home = retained[0]!.partition_no as number;
    await withoutOwner(f, home, async () => {
      expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut!, context())).status).toBe('unavailable');
    });
    expect(await f.snapshot([original, terminal])).toEqual(before);
    // Idempotent native release never replaces its original receipt.
    const work = { ...allowance(), rows: 0, points: 0, statements: 0, bytes: 0 };
    await releaseIdentityPrearmHome(f.pool, job, home, work);
    expect(
      (
        await f.pool.query(
          `SELECT partition_no,generation,release_transaction_id FROM semantic.identity_epoch_prearm_directory
      WHERE job_id=$1 ORDER BY partition_no,generation`,
          [job.jobId],
        )
      ).rows,
    ).toEqual(retained);
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('current');
    // A native relevant directory mutation invalidates the original release fence.
    await f.admin.query(
      `UPDATE semantic.identity_epoch_prearm_directory SET sequence=sequence+1
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
      [home, job.jobId, retained[0]!.generation],
    );
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('unavailable');
    expect(
      (await readIdentityPrearmCustodyPage(f.pool, { job, after: null, limit: 1, allowance: allowance() }, context()))
        .status,
    ).toBe('unavailable');
    // Older boolean-only releases remain unavailable after replay; do not launder a fresh receipt.
    await f.admin.query(
      `UPDATE semantic.identity_epoch_prearm_directory SET release_transaction_id=NULL
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
      [home, job.jobId, retained[0]!.generation],
    );
    await releaseIdentityPrearmHome(f.pool, job, home, work);
    expect(
      (
        await f.pool.query(
          `SELECT release_transaction_id FROM semantic.identity_epoch_prearm_directory
      WHERE partition_no=$1 AND job_id=$2 AND generation=$3`,
          [home, job.jobId, retained[0]!.generation],
        )
      ).rows[0].release_transaction_id,
    ).toBeNull();
    expect(
      (await readIdentityPrearmCustodyPage(f.pool, { job, after: null, limit: 1, allowance: allowance() }, context()))
        .status,
    ).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 180000);

test('Cancelled native sealed empty inputs retain real final pages and release provenance; missing or wrong input fences refuse', async () => {
  const f = await cutoverFixture();
  try {
    const original = (await f.create('Empty cancelled original', 0x8930)).id;
    const terminal = (await f.create('Empty cancelled survivor', 0x8940)).id;
    const actor = await f.actor(),
      key = randomUUID();
    const job = await identityEpochStore().prepareAdmission(
      f.pool,
      {
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
        ...context(),
      },
      {
        intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
        },
      },
    );
    for (let step = 0; step < 100; step++) {
      await stepIdentityEpochAdmission(f.pool, job);
      const row = (
        await f.pool.query(
          `SELECT prearm_phase,state FROM semantic.identity_epoch_job
        WHERE partition_no=$1 AND job_id=$2`,
          [identityJobPartition(job), job.jobId],
        )
      ).rows[0];
      expect(row.state).toBe('preparing');
      if (row.prearm_phase === 'prearm-sealed') break;
    }
    await cancelIdentityEpochAdmission(f.pool, job);
    for (let step = 0; step < 100; step++)
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') break;
    let after: IdentityFrontier | null = null,
      cut: IdentityPrearmCustodyCut | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await readIdentityPrearmCustodyPage(
        f.pool,
        { job, after, limit: 100, allowance: allowance() },
        context(),
      );
      if (result.status === 'unavailable') throw new Error(result.reason);
      expect(result.tickets).toHaveLength(0);
      if (result.status === 'complete') {
        cut = result.cut;
        break;
      }
      after = result.frontier;
    }
    if (!cut) throw new Error('Real empty cancelled directory did not exhaust');
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('current');
    await f.admin.query(
      `UPDATE semantic.identity_epoch_input SET generation=$3
      WHERE partition_no=$1 AND job_id=$2 AND terminal=$4`,
      [identityJobPartition(job), job.jobId, randomUUID(), original],
    );
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 120000);

test('The native colocated empty seal is retained without treating an absent directory as sealed zero', async () => {
  const f = await cutoverFixture();
  try {
    const original = (await f.create('Colocated original', 0x8950)).id;
    const terminal = (await f.create('Colocated survivor', 0x8951)).id;
    const actor = await f.actor(),
      key = randomUUID();
    const authority = {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
      ...context(),
    };
    const input = {
      intent: { kind: 'merge' as const, redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge' as const,
        command: { actorAccountId: actor.accountId, kind: 'subject.merge' as const, key, digest: digest(key) },
      },
    };
    const binding = await identityEpochStore().bindReceipt(f.pool, authority, input);
    const job: IdentityJobRef = (
      await runCommand(f.pool, { ...authority, partition: partitionOf(routeOf(original)!) }, (tx) =>
        identityEpochStore().admit(tx, { ...input, binding }),
      )
    ).value;
    await (
      await nativeCutoverCoordinator()
    )(f.pool, job);
    for (let step = 0; step < 10; step++) await stepIdentityEpochAdmission(f.pool, job);
    let after: IdentityFrontier | null = null,
      cut: IdentityPrearmCustodyCut | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await readIdentityPrearmCustodyPage(
        f.pool,
        { job, after, limit: 1, allowance: allowance() },
        context(),
      );
      if (result.status === 'unavailable') throw new Error(result.reason);
      expect(result.tickets).toHaveLength(0);
      if (result.status === 'complete') {
        cut = result.cut;
        break;
      }
      after = result.frontier;
    }
    if (!cut) throw new Error('Missing native colocated empty seal');
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('current');
    await f.admin.query(
      `UPDATE semantic.identity_epoch_input SET prearm_transaction_id=NULL
      WHERE partition_no=$1 AND job_id=$2`,
      [identityJobPartition(job), job.jobId],
    );
    expect((await verifyIdentityPrearmCustodyCut(f.pool, job, cut, context())).status).toBe('unavailable');
  } finally {
    await f.close();
  }
}, 180000);

test('Retained custody refuses omitted original input coverage before issuing its first continuation', async () => {
  const f = await cutoverFixture();
  try {
    const original = (await f.create('Coverage original', 0x8960)).id;
    const terminal = (await f.create('Coverage survivor', 0x8961)).id;
    const actor = await f.actor(),
      key = randomUUID();
    const authority = {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
      ...context(),
    };
    const input = {
      intent: { kind: 'merge' as const, redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge' as const,
        command: { actorAccountId: actor.accountId, kind: 'subject.merge' as const, key, digest: digest(key) },
      },
    };
    const binding = await identityEpochStore().bindReceipt(f.pool, authority, input);
    const job = (
      await runCommand(f.pool, { ...authority, partition: partitionOf(routeOf(original)!) }, (tx) =>
        identityEpochStore().admit(tx, { ...input, binding }),
      )
    ).value;
    await (
      await nativeCutoverCoordinator()
    )(f.pool, job);
    for (let step = 0; step < 10; step++) await stepIdentityEpochAdmission(f.pool, job);
    const request = { job, after: null, limit: 1, allowance: allowance() };
    expect((await readIdentityPrearmCustodyPage(f.pool, request, context())).status).toBe('progress');
    // Perturb only this existing fixture's owned database to simulate a missing retained head.
    // The immutable, original admission rows still require both native input generations.
    await f.admin.query('BEGIN');
    try {
      await f.admin.query("SET LOCAL semantic.erasure_cleanup='on'");
      const removed = await f.admin.query(
        `DELETE FROM semantic.identity_epoch_input
        WHERE partition_no=$1 AND job_id=$2 AND terminal=$3`,
        [identityJobPartition(job), job.jobId, original],
      );
      expect(removed.rowCount).toBe(1);
      await f.admin.query('COMMIT');
    } catch (error) {
      await f.admin.query('ROLLBACK');
      throw error;
    }
    const result = await readIdentityPrearmCustodyPage(f.pool, request, context());
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toBe('immutable-input-coverage-unavailable');
    expect('cut' in result).toBe(false);
    expect(result.work.rows).toBeLessThanOrEqual(100);
  } finally {
    await f.close();
  }
}, 180000);
