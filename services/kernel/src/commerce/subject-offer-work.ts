import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { identityEpochStore, identityJobPartition } from '../semantic/identity-epoch-store.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../semantic/events.ts';
import type { IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import type { WorkContext } from '../work/registry.ts';
import { readSubjectOfferSource, SUBJECT_OFFER_START } from './subject-offers.ts';
import bootstrap from './subject-offers-bootstrap.sql';
import sourcePage from './subject-offers-source.sql';
import upsert from './subject-offers-upsert.sql';
import remove from './subject-offers-remove.sql';
import advance from './subject-offers-advance.sql';
import movePage from './subject-offers-move-page.sql';

const basis = { actorAccountId: '00000000-0000-8000-8000-000000000001', clientId: 'internal-commerce-discovery', requestedBy: null };
async function available(client: CommandTransaction, home: number) {
  const owner = await readPartition(client, home);
  if (!owner || owner.writeState !== 'active')
    throw new CommandUnavailableError(owner?.writeState === 'moved' ? 'moved' : 'fenced', home, owner?.movedTo);
  return owner;
}

/** Replayed effects read current native source, not their historical event revision or payload. */
export function projectSubjectOffer(pool: Pool, offerId: string, deadline: number, previousTerminal?: string): Promise<void> {
  return withRequestDeadline(deadline, async () => {
    const source = await readSubjectOfferSource(pool, offerId, deadline);
    // Deleted/terminal sources have no publishable payload. Retained locators never authorize reads.
    if (!source?.contentEdition) return;
    if (source.targetSubjectId !== source.contentEdition.targetSubjectId || source.creatorAccountId !== source.contentEdition.creatorAccountId)
      throw new Error('Offer capture differs from its immutable native source');
    const [mapping] = await readIdentityMappings(pool, [source.targetSubjectId]);
    if (mapping?.state !== 'mapped') throw new CommandUnavailableError('fenced', partitionOf(routeOf(source.targetSubjectId)!));
    const key = {
      route: routeOf(mapping.terminal)!, subject: mapping.terminal, offer: offerId,
      original: source.targetSubjectId, revision: source.revision, epoch: mapping.epoch.toString(), listed: source.state === 'active',
    };
    await runCommand(pool, { partition: partitionOf(key.route), basis, deadline }, async (tx) => {
      await upsert.run(tx, key);
      return noEffect(null);
    });
    // No directory client is held across either native source or identity collection.
    const final = await readSubjectOfferSource(pool, offerId, deadline);
    const [identity] = await readIdentityMappings(pool, [source.targetSubjectId]);
    if (!final || final.revision !== source.revision || identity?.state !== 'mapped' ||
        identity.terminal !== mapping.terminal || identity.epoch !== mapping.epoch)
      throw new CommandUnavailableError('fenced', partitionOf(key.route));
    if (previousTerminal && previousTerminal !== mapping.terminal) {
      const old = { ...key, route: routeOf(previousTerminal)!, subject: previousTerminal };
      await runCommand(pool, { partition: partitionOf(old.route), basis, deadline }, async (tx) => {
        await remove.run(tx, old);
        return noEffect(null);
      });
    }
    requireAccessDeadline(deadline);
  });
}

/** Initial backfill and recovery share one scalar raw frontier, with native CAS against late steppers.
 * A full pass establishes only a directory bootstrap snapshot. Subsequent effects remain eventual.
 */
export function advanceSubjectOfferBootstrap(pool: Pool, deadline: number): Promise<void> {
  return withRequestDeadline(deadline, async () => {
    const state = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await available(client, 0);
      return bootstrap.run(client, {});
    });
    if (!state) throw new CommandUnavailableError('fenced', 0);
    const [homeText, after] = state.frontier.split('/');
    const home = Number(homeText);
    if (!Number.isInteger(home) || home < 0 || home >= PARTITIONS || !after) throw new Error('Invalid discovery frontier');
    const raw = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const owner = await available(client, home);
      return { rows: await sourcePage.run(client, { home, after }), epoch: owner.epoch };
    });
    for (const row of raw.rows) await projectSubjectOffer(pool, row.id, deadline);
    // Confirm the source owner epoch after all foreign homes, before checkpointing.
    await withConnection(pool, async (connection) => {
      const owner = await available(deadlineClient(connection, deadline), home);
      if (owner.epoch !== raw.epoch) throw new CommandUnavailableError('fenced', home);
    });
    const exhausted = raw.rows.length < 100;
    const complete = exhausted && home === PARTITIONS - 1;
    const frontier = exhausted ? `${complete ? 0 : home + 1}/${SUBJECT_OFFER_START}` : `${home}/${raw.rows.at(-1)!.id}`;
    await runCommand(pool, { partition: 0, basis, deadline }, async (tx) => {
      await advance.run(tx, { frontier, version: state.version, previous: state.frontier, ready: complete });
      return noEffect(null);
    });
  });
}

/** Indexed moves consume Semantic's actual published input-generation pages, never all originals. */
async function moveOriginal(pool: Pool, original: string, previous: string, after: string): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  return withRequestDeadline(deadline, async () => {
    const route = routeOf(previous)!;
    const rows = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await available(client, partitionOf(route));
      return movePage.run(client, { route, subject: previous, original, after });
    });
    for (const row of rows) await projectSubjectOffer(pool, row.id, deadline, previous);
    return rows.length === 100 ? rows.at(-1)!.id : null;
  });
}

export function registerSubjectOfferWork(context: WorkContext): void {
  const retries = { retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1, backoffRate: 2 };
  const changes = DBOS.registerStep(async (jobId: string, epoch: string, after: string | null) => {
    const job: IdentityJobRef = { jobId, epoch: BigInt(epoch) };
    return withConnection(context.pool, async (tx) => {
      await available(tx, identityJobPartition(job));
      const native = await identityEpochStore.readJob(tx, job);
      if (native?.state !== 'published') throw new CommandUnavailableError('fenced', identityJobPartition(job));
      return identityEpochStore.pageChanges(tx, job, after);
    });
  }, { name: 'commerce.subjectOffers.identityPage', ...retries });
  const move = DBOS.registerStep((original: string, previous: string, after: string) => moveOriginal(context.pool, original, previous, after),
    { name: 'commerce.subjectOffers.move', ...retries });
  DBOS.registerWorkflow(async (jobId: string, epoch: string) => {
    let after: string | null = null;
    do {
      const page = await changes(jobId, epoch, after);
      for (const change of page.changes) {
        let cursor: string | null = SUBJECT_OFFER_START;
        do { cursor = await move(change.original, change.previousTerminal, cursor); } while (cursor !== null);
      }
      after = page.next;
    } while (after !== null);
  }, { name: 'commerce.subjectOffers.identity' });
  context.addEffects([
    {
      name: 'commerce_subject_offers',
      types: ['com.rezics.commerce.offer.created.v1', 'com.rezics.commerce.offer.revised.v1', 'com.rezics.commerce.offer.delisted.v1'],
      async run(event) {
        const { offerId } = event.data as { offerId: string };
        await projectSubjectOffer(context.pool, offerId, Date.now() + 5_000);
      },
    },
    {
      name: 'commerce_subject_offer_identity', types: [IDENTITY_EPOCH_ADMITTED],
      async run(event) {
        const { jobId, epoch } = event.data as { jobId: string; epoch: string };
        const job = { jobId, epoch: BigInt(epoch) };
        const native = await withConnection(context.pool, (tx) => identityEpochStore.readJob(tx, job));
        // Admission also emits this event. Only the producer's published event can start moves.
        if (native?.state !== 'published') return;
        const handle = await context.client.enqueue({ workflowName: 'commerce.subjectOffers.identity',
          workflowID: `commerce:subject-offers:identity:${jobId}:${epoch}`, workflowIDReusePolicy: 'return-existing', queueName: 'effects' }, jobId, epoch);
        await handle.getResult();
      },
    },
  ]);
  context.addService(() => {
    let stopped = false;
    let wake: (() => void) | undefined;
    const running = (async () => {
      while (!stopped) {
        try { await advanceSubjectOfferBootstrap(context.pool, Date.now() + 20_000); }
        catch (error) { console.error('Commerce subject offer projection remains preparing', error); }
        if (!stopped) await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    return { async stop() { stopped = true; wake?.(); await running; } };
  });
}
