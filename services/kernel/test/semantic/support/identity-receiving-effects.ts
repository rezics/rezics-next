import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { stepIdentityEpochAdmission } from '../../../src/semantic/identity-epoch-admission.ts';
import { identityEpochStore as store } from '../../../src/semantic/identity-epoch-store.ts';
import type { IdentityEpochStep, IdentityJobRef } from '../../../src/semantic/identity-epoch-contract.ts';
import { routeOf } from '../../../src/route/route.ts';
import { digest, release, type EpochFixture } from './identity-epoch.ts';
import { libraryCutoverInput } from './identity-epoch-cutover.ts';

let nextRoute = 0x8a10;

/** Real Library commands and native admission; no proof, gate, receipt or ACK rows are fixture-written. */
export async function admittedReceivingJob(f: EpochFixture, options: { pending?: boolean } = {}) {
  const route = nextRoute;
  nextRoute += 0x20;
  const original = (await f.create('Receiving effect original', route)).subject.id;
  const terminal = (await f.create('Receiving effect terminal', route + 0x10)).subject.id;
  const library = await libraryCutoverInput(f, [original, terminal]);
  const actor = await f.actor();
  const key = randomUUID();
  const job = await store().prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
    },
    {
      intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
      },
    },
  );
  for (let step = 0; options.pending !== false && step < 16; step++) {
    const progress = await stepIdentityEpochAdmission(f.pool, job);
    if (progress.state === 'pending') break;
    expect(progress.state).toBe('preparing');
  }
  expect((await store().readJob(f.pool, job))?.state).toBe(options.pending === false ? 'preparing' : 'pending');
  const members = async () =>
    (
      await f.admin.query(
        'SELECT * FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
        [routeOf(library.collection.id), library.collection.id],
      )
    ).rows;
  return { original, terminal, library, job, members };
}

/** The sole participant named by its owner contract. A missing producer is a failure, never empty coverage. */
export async function completeReceivingParticipant(f: EpochFixture, job: IdentityJobRef) {
  const path = new URL('../../../src/library/identity-epoch-participant.ts', import.meta.url);
  const module: { stepLibraryIdentityEpoch?: IdentityEpochStep } = await import(path.href);
  if (typeof module.stepLibraryIdentityEpoch !== 'function')
    throw new Error('Missing native library/identity-epoch-participant.ts export stepLibraryIdentityEpoch');
  for (let step = 0; step < 128; step++) {
    const progress = await module.stepLibraryIdentityEpoch(f.pool, job);
    expect(progress.job).toEqual(job);
    expect(progress.receipt.step).toBe('library-private-follow-counts');
    expect(progress.receipt.version).toBe(1);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'complete') return progress;
  }
  throw new Error('Native receiving effects did not finish the finite Library source');
}
