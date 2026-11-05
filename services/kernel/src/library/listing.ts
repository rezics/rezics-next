import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  authoritativeTimeValue,
  commandTime,
  CommandUnavailableError,
  DEFAULT_REQUEST_DEADLINE_MS,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { runOperationalTransaction } from '../command/operational.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { partitionOf } from '../route/route.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { requireRoute } from './command-support.ts';
import apply from './listing-apply.sql';
import { executeSubjectCollectionPairs, subjectCollectionPairPlan } from './subject-collection-read-bounds.ts';
import type { CollectionReadOperationUse } from './collection-directory-bounds.ts';
import {
  admitListingSource,
  observeListingSource,
  observeListingDeliverySource,
  terminalListingCurator,
} from './listing-source-observer.ts';
import type { ListingObservation } from './listing-freshness-contract.ts';

import {
  LiveCopyPendingError,
  liveCopyLocator,
  readLiveCopy,
  readLiveCopyResult,
  admitLiveCopyRoles,
  observeLiveCopyAdmissions,
  openLiveCopyGate,
  finishLiveCopyGate,
  cancelLiveCopy,
  consumeLiveCopy,
  type LiveCopyLocator,
} from '../access/live-copy.ts';

class Unchanged extends Error {}
class StampOnly extends Error {}
class ProjectionChanged extends Error {}
const unchanged = { changed: false } as const;
type Dependencies = { pool: Pool; clock?: () => Date; client?: WorkClient };

/** Trusted projection work: read and release the Collection anchor before entering the subject command. */
export async function syncSubjectListing(
  dependencies: Dependencies,
  { subjectId, collectionId }: { subjectId: string; collectionId: string },
) {
  const source = await observeListingSource(dependencies.pool, { subjectId, collectionId });
  const work =
    dependencies.client ?? (await createWorkClient(dependencies.pool.options.connectionString!, dependencies.pool));
  try {
    // Negative work updates only identities already present in the receiver. It
    // needs neither an active erased curator nor a new personal source payload.
    if (source.multiplicity === 0)
      return await cleanupNegativeListing(
        { ...dependencies, client: work },
        source,
        await terminalListingCurator(dependencies.pool, { subjectId, collectionId }),
      );
    const copy = await admitListingSource({ pool: dependencies.pool, client: work }, { subjectId, collectionId });
    if (!copy) {
      const latest = await observeListingSource(dependencies.pool, { subjectId, collectionId });
      if (latest.multiplicity === 0)
        return await cleanupNegativeListing(
          { ...dependencies, client: work },
          latest,
          await terminalListingCurator(dependencies.pool, { subjectId, collectionId }),
        );
      throw new CommandUnavailableError('deadline', partitionOf(requireRoute(collectionId)));
    }
    return await recoverSubjectListing({ ...dependencies, client: work }, liveCopyLocator(copy));
  } finally {
    if (!dependencies.client) await work.close();
  }
}

/** Genuine curator T bars every prior positive replay. Remove retained identities only;
 * a later replacement beyond this exact cut remains untouched. */
async function cleanupTerminalListing(deps: Dependencies & { client: WorkClient }, source: ListingObservation) {
  return cleanupNegativeListing(deps, source, true);
}

async function cleanupNegativeListing(
  deps: Dependencies & { client: WorkClient },
  source: ListingObservation,
  terminal = false,
) {
  if (source.multiplicity !== 0) throw new TypeError('Listing cleanup must be negative');
  const route = requireRoute(source.subjectId),
    partition = partitionOf(route);
  const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  const remove = async (
    tx: CommandTransaction | import('../command/operational.ts').OperationalTransaction,
    time: string,
    transactionId: string,
  ) => {
    const removed = await tx.query(
      `WITH removed AS (
      DELETE FROM library.subject_collection WHERE route=$1 AND subject_id=$2 AND collection_id=$3
        AND (source_epoch IS NULL OR (source_epoch,source_position)<=($4,$5::bigint)) RETURNING subject_id)
      UPDATE library.subject_listing SET public_collection_count=public_collection_count-1,revision=revision+1,
        updated_at=$6::timestamptz,transaction_id=$7::uuid
      WHERE route=$1 AND subject_id=$2 AND EXISTS(SELECT 1 FROM removed) RETURNING subject_id`,
      [
        route,
        source.subjectId,
        source.collectionId,
        source.stamp.epoch,
        source.stamp.position.toString(),
        time,
        transactionId,
      ],
    );
    if (terminal) {
      await tx.query(
        `DELETE FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3
        AND (source_epoch,source_position)<=($4,$5::bigint)`,
        [route, source.subjectId, source.collectionId, source.stamp.epoch, source.stamp.position.toString()],
      );
    } else {
      // Keep an existing monotone exclusion cut for delayed positive deliveries;
      // an absent pair/version never becomes a freshly copied zero identity.
      await tx.query(
        `UPDATE library.subject_collection_version SET multiplicity=0,source_epoch=$4,source_position=$5,
          updated_at=$6::timestamptz,transaction_id=$7::uuid
        WHERE route=$1 AND subject_id=$2 AND collection_id=$3 AND (source_epoch,source_position)<=($4,$5::bigint)`,
        [
          route,
          source.subjectId,
          source.collectionId,
          source.stamp.epoch,
          source.stamp.position.toString(),
          time,
          transactionId,
        ],
      );
    }
    return removed.rowCount !== 0;
  };
  while (Date.now() < deadline) {
    try {
      await runOperationalTransaction(
        deps.pool,
        {
          mode: 'work-step',
          partition,
          kind: 'library.listing.negativeCleanup',
          accounts: [],
          workClient: deps.client,
          deadline,
        },
        async (tx) => {
          if (await remove(tx, authoritativeTimeValue(commandTime(tx)!), randomUUID())) throw new ProjectionChanged();
        },
      );
      return unchanged;
    } catch (error) {
      if (!(error instanceof ProjectionChanged)) throw error;
    }
    try {
      return await runCommand(deps.pool, { partition, clock: deps.clock, deadline }, async (tx, command) => {
        if (!(await remove(tx, authoritativeTimeValue(command.time), command.transactionId))) throw new Unchanged();
        return {
          value: { changed: true },
          events: [
            {
              type: 'com.rezics.library.subject.listed.v1',
              subject: source.subjectId,
              data: { subjectId: source.subjectId },
            },
          ],
        };
      });
    } catch (error) {
      if (!(error instanceof Unchanged)) throw error;
    }
  }
  throw new CommandUnavailableError('deadline', partition);
}

/** Compatibility entrypoint for released observations. The observation is a locator,
 * never reusable authority to write across homes. Re-read and use native receiving. */
export async function applySubjectListing(deps: Dependencies, source: ListingObservation) {
  const current = await observeListingSource(deps.pool, source);
  if (
    current.stamp.epoch === source.stamp.epoch &&
    current.stamp.position === source.stamp.position &&
    (current.multiplicity !== source.multiplicity || current.currentlyPublic !== source.currentlyPublic)
  )
    throw new Error('Listing equal-stamp source conflict');
  return syncSubjectListing(deps, { subjectId: source.subjectId, collectionId: source.collectionId });
}

/** Public Collection pairs in Collection ID order, bounded by a subject-leading keyset seek. */
export async function subjectCollections(
  pool: Pool,
  subjectId: string,
  after: string | null,
  limit: number,
  options: { deadline?: number; operation?: CollectionReadOperationUse } = {},
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new RangeError('Page limit must be an integer from 1 through 5000');
  const route = requireRoute(subjectId);
  if (after !== null) requireRoute(after);
  const plan = subjectCollectionPairPlan({
    route,
    subject_id: subjectId,
    after: after ?? '00000000-0000-0000-0000-000000000000',
    limit,
  });
  return withConnection(pool, async (connection) => {
    options.operation?.consume('subjectPairPage');
    const client = options.deadline === undefined ? connection : deadlineClient(connection, options.deadline);
    const rows = await executeSubjectCollectionPairs({ query: client.query.bind(client) }, plan);
    return rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() }));
  });
}

/** Default receiver and recovery share one immutable source transition and exact gate. */
export async function recoverSubjectListing(deps: Dependencies & { client: WorkClient }, locator: LiveCopyLocator) {
  const copy = await readLiveCopy(deps.pool, locator);
  if (!copy || copy.module !== 'library.subject-listing' || copy.state === 'retired') return unchanged;
  if (await readLiveCopyResult(deps.pool, copy)) {
    await consumeLiveCopy(deps, copy);
    return unchanged;
  }
  if (!copy.payload || !(await admitLiveCopyRoles(deps, copy))) {
    await cancelLiveCopy(deps, copy);
    await consumeLiveCopy(deps, copy);
    return unchanged;
  }
  const payload = copy.payload as unknown as Omit<ListingObservation, 'stamp'> & {
    stamp: { partition: number; epoch: number; position: string };
  };
  const current = await observeListingDeliverySource(deps.pool, {
    subjectId: payload.subjectId,
    collectionId: payload.collectionId,
  });
  if (
    current.epoch !== copy.source_epoch ||
    current.collection?.transaction_id !== copy.effect_key.transactionId ||
    current.collection?.revision !== copy.effect_key.revision ||
    current.truth.multiplicity !== payload.multiplicity ||
    current.truth.currentlyPublic !== payload.currentlyPublic
  ) {
    await cancelLiveCopy(deps, copy);
    await consumeLiveCopy(deps, copy);
    return unchanged;
  }
  const proof = await observeLiveCopyAdmissions(deps.pool, copy);
  if (!proof) {
    await cancelLiveCopy(deps, copy);
    await consumeLiveCopy(deps, copy);
    return unchanged;
  }
  const { pool, client, clock } = deps;
  const partition = partitionOf(copy.receiver_route);
  const replace = (
    tx: CommandTransaction | import('../command/operational.ts').OperationalTransaction,
    time: string,
    transactionId: string,
  ) =>
    apply.run(tx, {
      route: copy.receiver_route,
      subject_id: payload.subjectId,
      collection_id: payload.collectionId,
      collection_route: payload.collectionRoute,
      multiplicity: payload.multiplicity,
      source_partition: payload.stamp.partition,
      source_epoch: payload.stamp.epoch,
      source_position: payload.stamp.position,
      ever_public: payload.everPublic || payload.currentlyPublic,
      time,
      transaction_id: transactionId,
    });
  const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const result = await runCommand(pool, { partition, clock, deadline }, async (tx, command) => {
        const terminal = await openLiveCopyGate(tx, copy, proof);
        if (terminal) throw new Unchanged();
        const value = await replace(tx, authoritativeTimeValue(command.time), command.transactionId);
        if (!value) throw new Error('Listing replacement returned no row');
        if (!value.projectionChanged) throw new StampOnly();
        await finishLiveCopyGate(tx, copy, 'applied');
        return {
          value,
          events: [
            {
              type: 'com.rezics.library.subject.listed.v1',
              subject: payload.subjectId,
              data: { subjectId: payload.subjectId },
            },
          ],
        };
      });
      await consumeLiveCopy(deps, copy);
      return { ...result, changed: true };
    } catch (error) {
      if (error instanceof Unchanged) {
        await consumeLiveCopy(deps, copy);
        return unchanged;
      }
      if (!(error instanceof StampOnly)) throw error;
    }
    try {
      await runOperationalTransaction(
        pool,
        {
          mode: 'work-step',
          partition,
          kind: 'library.listing.receive',
          accounts: [],
          workClient: client,
          ...(clock === undefined ? {} : { clock }),
          deadline,
        },
        async (tx) => {
          const terminal = await openLiveCopyGate(tx, copy, proof);
          if (terminal) return;
          const value = await replace(tx, authoritativeTimeValue(commandTime(tx)!), randomUUID());
          if (!value) throw new Error('Listing replacement returned no row');
          if (value.projectionChanged) throw new ProjectionChanged();
          await finishLiveCopyGate(tx, copy, value.advanced ? 'applied' : 'superseded');
        },
      );
      await consumeLiveCopy(deps, copy);
      return unchanged;
    } catch (error) {
      if (!(error instanceof ProjectionChanged)) throw error;
    }
  }
  throw new CommandUnavailableError('deadline', partition);
}

/** One old native pair or version per step; successful new writers enroll themselves below/above
 * this frontier. Historic missing source evidence keeps this exact frontier pending. */
export async function bootstrapSubjectListingHome(
  deps: Dependencies & { client: WorkClient },
  partition: number,
): Promise<boolean> {
  const selected = await withReadTransaction(deps.pool, async (tx) => {
    const frontier = (
      await tx.query<{ after_route: number; after_subject: string; after_collection: string; covered: boolean }>(
        'SELECT after_route,after_subject,after_collection,covered FROM access.live_copy_bootstrap WHERE partition_no=$1',
        [partition],
      )
    ).rows[0];
    if (!frontier) throw new Error('Live copy migration frontier unavailable');
    if (frontier.covered) return { frontier, row: null, covered: true };
    const row =
      (
        await tx.query<{ route: number; subject_id: string; collection_id: string }>(
          `SELECT * FROM (
      (SELECT route,subject_id,collection_id FROM library.subject_collection
       WHERE route BETWEEN $1 AND $2 AND (route,subject_id,collection_id)>($3,$4::uuid,$5::uuid)
       ORDER BY route,subject_id,collection_id LIMIT 1)
      UNION ALL
      (SELECT route,subject_id,collection_id FROM library.subject_collection_version
       WHERE route BETWEEN $1 AND $2 AND (route,subject_id,collection_id)>($3,$4::uuid,$5::uuid)
       ORDER BY route,subject_id,collection_id LIMIT 1)
      ) candidates ORDER BY route,subject_id,collection_id LIMIT 1`,
          [
            partition * 16,
            partition * 16 + 15,
            frontier.after_route,
            frontier.after_subject,
            frontier.after_collection,
          ],
        )
      ).rows[0] ?? null;
    return { frontier, row, covered: false };
  });
  if (selected.covered) return false;
  if (selected.row) {
    const { subject_id: subjectId, collection_id: collectionId } = selected.row;
    const observation = await observeListingSource(deps.pool, { subjectId, collectionId });
    try {
      if (observation.multiplicity === 0) {
        await cleanupNegativeListing(
          deps,
          observation,
          await terminalListingCurator(deps.pool, { subjectId, collectionId }),
        );
      } else {
        const copy = await admitListingSource(deps, { subjectId, collectionId });
        if (!copy) return false;
        await recoverSubjectListing(deps, liveCopyLocator(copy));
        const result = await readLiveCopyResult(deps.pool, copy);
        if (!result) return false;
        if (result.outcome === 'cancelled') throw new LiveCopyPendingError('Listing receiver effect cancelled');
        const stamp = copy.payload?.stamp as { epoch: number; position: string } | undefined;
        const uncovered = await withReadTransaction(
          deps.pool,
          async (tx) =>
            (
              await tx.query(
                `SELECT 1 FROM library.subject_collection WHERE route=$1 AND subject_id=$2 AND collection_id=$3
         AND (source_epoch IS NULL OR (source_epoch,source_position)>($4,$5::bigint))
         UNION ALL SELECT 1 FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3
         AND (source_epoch,source_position)>($4,$5::bigint) LIMIT 1`,
                [selected.row!.route, subjectId, collectionId, stamp?.epoch ?? 0, stamp?.position ?? '0'],
              )
            ).rowCount !== 0,
        );
        // An old global observation cut cannot be relabelled as this business commit's
        // original role proof. Preserve the exact historical coverage gap.
        if (uncovered) return false;
      }
    } catch (error) {
      if (
        !(error instanceof LiveCopyPendingError) ||
        observation.multiplicity !== 0 ||
        !(await terminalListingCurator(deps.pool, { subjectId, collectionId }))
      )
        throw error;
      await cleanupTerminalListing(deps, observation);
    }
  }
  await runOperationalTransaction(
    deps.pool,
    { mode: 'work-step', partition, kind: 'library.listing.bootstrap', accounts: [], workClient: deps.client },
    async (tx) => {
      const next = selected.row;
      await tx.query(
        `UPDATE access.live_copy_bootstrap SET after_route=$5,after_subject=$6,after_collection=$7,covered=$8
      WHERE partition_no=$1 AND (after_route,after_subject,after_collection)=($2,$3::uuid,$4::uuid) AND NOT covered`,
        [
          partition,
          selected.frontier.after_route,
          selected.frontier.after_subject,
          selected.frontier.after_collection,
          next?.route ?? selected.frontier.after_route,
          next?.subject_id ?? selected.frontier.after_subject,
          next?.collection_id ?? selected.frontier.after_collection,
          !next,
        ],
      );
    },
  );
  return !!selected.row;
}
