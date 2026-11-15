import { expect, test } from 'bun:test';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';

test('native mapping drains actual admitted cross-home effects with real receipt custody but cannot publish missing participants', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await f.admitMerge();
    const progress = await f.drainMapping(input.job, 512);
    expect(progress.length).toBeGreaterThan(0);
    const final = progress.at(-1)!;
    expect(final.job).toEqual(input.job);
    expect(final.state).toBe('complete');
    expect(final.receipt.step).toBe('mapping');
    expect(final.receipt.version).toBe(1);
    for (const row of progress) {
      expect(row.frontier.after.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(row.frontier))).toBeLessThanOrEqual(2048);
    }
    for (const original of input.redirectedOriginals)
      expect(await f.nativeDirectRedirect(original)).toBe(input.survivor);
    const ack = await identityEpochStore().reconcileStepReceipt(f.pool, final.receipt);
    expect(ack).toEqual(final);
    const job = await f.readJob(input.job);
    expect(job!.mapping!.state).toBe('complete');
    expect(job!.participants['search-canonical-index']).toBeNull();
    const library = await stepLibraryIdentityEpoch(f.pool, input.job);
    expect(library.state).toBe('complete');
    expect(library.receipt.step).toBe('library-private-follow-counts');
    const libraryAck = await identityEpochStore().reconcileStepReceipt(f.pool, library.receipt);
    expect(libraryAck.state).toBe('complete');
    expect((await f.readJob(input.job))!.participants['library-private-follow-counts']?.state).toBe('complete');
    await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect((await f.readJob(input.job))!.state).not.toBe('published');
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);

test('account-agent verify mapping drains from original Access source for linked agent subjects', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await f.admitAccountAgentVerify();
    expect(input.source.input.receipt).toEqual(input.receipt);
    expect(input.source.input.intent.kind).toBe('merge');
    const intent = input.source.input.intent;
    if (intent.kind !== 'merge') throw new Error('Account verification must retain its merge identity');
    const sourceRoute = routeOf(intent.redirected);
    if (sourceRoute === null) throw new Error('Account verification original must retain its native route');
    const native = await f.nativeSource(intent.redirected);
    expect(native.closure_state).toBe('active');
    expect(native.source_home).not.toBe(native.control_partition);
    expect(native.control_group).toBe(input.control);
    expect(native.original_installed).toBe(true);
    expect([...native.commits].sort()).toEqual(['ack', 'install', 'registration']);
    const pins = await f.nativeAdmissionPins(input.job, native.control_partition);
    expect(pins).toEqual({ attempt: 'acquired', prepared: 'prepared', acquired: 'acquired' });
    const progress = await f.drainMapping(input.job, 512);
    expect(progress.at(-1)).toMatchObject({
      job: input.job,
      state: 'complete',
      receipt: { step: 'mapping', version: 1 },
    });
    const job = await f.readJob(input.job);
    expect(job!.mapping!.state).toBe('complete');
    expect(job!.receipt).toEqual(input.receipt);
    expect(job!.state).not.toBe('published');
    const retained = await f.nativeSource(intent.redirected);
    expect(retained.closure_state).toBe('withdrawn');
    expect(retained.registration).toBe(native.registration);
    expect(retained.install).toBe(native.install);
    expect(retained.ack).toBe(native.ack);
    expect(await f.nativeAdmissionPins(input.job, native.control_partition)).toEqual(pins);
    const committed = await f.admin.query<{
      original: string;
      terminal: string;
      epoch: string;
      transaction_id: string;
    }>(
      `SELECT m.original::text, m.terminal::text, m.epoch::text, m.recorded_transaction_id::text AS transaction_id
       FROM semantic.identity_epoch_mapping m
       JOIN semantic.identity_epoch_native_commit c
         ON c.partition_no=$2 AND c.transaction_id=m.recorded_transaction_id
        AND c.purpose='mapping' AND c.xmin=m.xmin
       WHERE m.route=$1 AND m.original=$3`,
      [sourceRoute, partitionOf(sourceRoute), intent.redirected],
    );
    expect(committed.rows).toEqual([
      {
        original: intent.redirected,
        terminal: intent.survivor,
        epoch: input.job.epoch.toString(),
        transaction_id: expect.any(String),
      },
    ]);
    await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  } finally {
    await f.close();
  }
}, 180_000);

test('account-agent verify mapping refuses a changed acquired pin on an active foreign-control source', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await f.admitAccountAgentVerify();
    const intent = input.source.input.intent;
    if (intent.kind !== 'merge') throw new Error('Account verification must retain its merge identity');
    const native = await f.nativeSource(intent.redirected);
    expect(native.closure_state).toBe('active');
    expect(native.source_home).not.toBe(native.control_partition);
    expect(native.control_group).toBe(input.control);
    const before = await f.sourceFactSnapshot([intent.redirected, input.control]);
    await f.closeAcquiredPin(input.job, native.control_partition);
    await expect(f.drainMapping(input.job, 512)).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
    expect(await f.sourceFactSnapshot([intent.redirected, input.control])).toEqual(before);
    expect(await f.nativeSource(intent.redirected)).toEqual(native);
    expect(await f.nativeDirectRedirect(intent.redirected)).toBe(input.control);
    expect((await f.readJob(input.job))!.mapping?.state).not.toBe('complete');
    expect((await f.readJob(input.job))!.state).not.toBe('published');
    const rows = await f.nativeRows(input.job);
    expect(rows.effects.filter((row) => row.partition_no === native.source_home)).toEqual([]);
  } finally {
    await f.close();
  }
}, 180_000);
