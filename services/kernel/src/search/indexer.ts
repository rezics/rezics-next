import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { spaceDiscoveryInvalidation, SPACE_DISCOVERY_NATIVE_EVENTS } from '../community/space-discovery.ts';
import type { DiscoveryKey } from './discovery.ts';
import type { DiscoveryProjection } from './account-discovery.ts';
import type { Pool } from 'pg';
import { projectBatch, type Envelope } from '../events/log.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import type { Relay } from '../events/relays.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions, validateIndexObservation } from './document.ts';
import { SEARCH_IDENTITY_WRITER_CHUNK, type SearchWriterGuard } from './writer-guard.ts';
import type { OpenSearch } from './opensearch.ts';
import { subjectPartition, type SubjectListingSource, type SubjectSource } from './source.ts';
import { writeIndexActions } from './write-actions.ts';

export { IndexWriteError } from './write-actions.ts';

/** Internal composition only: admission must reject or await the same real apply exactly once. */
export type SubjectApplyGuard = (
  partition: number,
  envelopes: readonly Envelope[],
  apply: () => Promise<void>,
) => Promise<void>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { validateIndexObservation as validateObservation } from './document.ts';

/** Lifecycle invalidations carry only the native subject/candidate identities.
 * Context lifecycle events have the same event names but are not subject mutations. */
function subjectChanged(event: Envelope['events'][number]): boolean {
  if (event.type.startsWith('com.rezics.subject.') || event.type === 'com.rezics.library.subject.listed.v1')
    return true;
  if (!['com.rezics.semantic.record.deleted.v1', 'com.rezics.semantic.record.restored.v1'].includes(event.type))
    return false;
  return (
    lookupEventType(event.type)?.Check(event.data) === true &&
    record(event.data) &&
    event.data.kind === 'candidate' &&
    event.data.subject === event.subject
  );
}

export function createSubjectIndexer(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  index: string;
  consumer: string;
  /** Matches the target physical mapping; historical generations keep the year-only writer shape. */
  calendarFormat?: 1;
  aroundApply?: SubjectApplyGuard;
  /** Trusted native runner composition; independent of aroundApply/privacy repair. */
  writer?: SearchWriterGuard;
  envelopes?: number;
}): Relay {
  return {
    consumer: options.consumer,
    run(partition) {
      return projectBatch(options.pool, {
        consumer: options.consumer,
        partition,
        ...(options.envelopes === undefined ? {} : { envelopes: options.envelopes }),
        apply: async (envelopes) => {
          const apply = async () => {
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const envelope of envelopes) {
              if (envelope.partition !== partition) continue;
              for (const event of envelope.events) {
                if (subjectChanged(event)) {
                  if (!event.subject || seen.has(event.subject)) continue;
                  if (subjectPartition(event.subject) !== partition) continue;
                  seen.add(event.subject);
                  ids.push(event.subject);
                  continue;
                }
                if (event.type !== 'com.rezics.rating.public_figure.changed.v1') continue;
                const validator = lookupEventType(event.type);
                if (!validator?.Check(event.data)) continue;
                const data = event.data as { questionId: string; populationId: string; subjectId: string };
                // Event metadata is an invalidation hint only. Accept its anchor after proving the
                // registered identity agrees with the envelope and the current public contract.
                if (
                  data.questionId !== STANDARD_QUESTION_ID ||
                  data.populationId !== GLOBAL_CONTEXT.id ||
                  event.subject !== data.subjectId ||
                  seen.has(data.subjectId)
                )
                  continue;
                try {
                  if (subjectPartition(data.subjectId) !== partition) continue;
                } catch {
                  continue;
                }
                seen.add(data.subjectId);
                ids.push(data.subjectId);
              }
            }
            if (ids.length === 0) return;

            // Every chunk must cover the entire captured batch that this apply will acknowledge.
            const obligation = envelopes.at(-1)!.position;
            for (let offset = 0; offset < ids.length; offset += 1000)
              await applySubjectKeys(options, partition, ids.slice(offset, offset + 1000), obligation);
          };
          await guardedApply(options.aroundApply, partition, envelopes, apply);
        },
      });
    },
  };
}

/** The shared relay captures both owners in one 64-envelope checkpoint obligation. */
export function createDiscoveryIndexer(pool: Pool, projection: DiscoveryProjection, consumer: string): Relay {
  return {
    consumer,
    run(partition) {
      return projectBatch(pool, {
        consumer,
        partition,
        apply: async (envelopes) => {
          const subjects = new Set<string>(),
            accounts = new Set<string>(),
            collections = new Set<string>(),
            spaces = new Set<string>();
          for (const envelope of envelopes)
            for (const event of envelope.events) {
              if (!event.subject || subjectPartition(event.subject) !== partition) continue;
              if (subjectChanged(event)) subjects.add(event.subject);
              if (event.type === 'com.rezics.rating.public_figure.changed.v1') {
                const data = event.data;
                if (
                  record(data) &&
                  data.questionId === STANDARD_QUESTION_ID &&
                  data.populationId === GLOBAL_CONTEXT.id &&
                  data.subjectId === event.subject
                )
                  subjects.add(event.subject);
              }
              if (
                [
                  'com.rezics.access.account-discovery-changed.v1',
                  'com.rezics.access.account-updated.v1',
                  'com.rezics.access.account-tombstoned.v1',
                ].includes(event.type)
              )
                accounts.add(event.subject);
              if (
                [
                  'com.rezics.library.collection.updated.v1',
                  'com.rezics.library.collection.deleted.v1',
                  'com.rezics.library.collection.listing.changed.v1',
                ].includes(event.type) &&
                lookupEventType(event.type)?.Check(event.data) === true &&
                record(event.data) &&
                typeof event.data.collectionId === 'string' &&
                event.data.collectionId === event.subject &&
                routeOf(event.subject) !== null
              )
                collections.add(event.subject);
              if (SPACE_DISCOVERY_NATIVE_EVENTS.includes(event.type)) {
                const invalidation = await spaceDiscoveryInvalidation(
                  pool,
                  event as Parameters<typeof spaceDiscoveryInvalidation>[1],
                );
                if (invalidation?.target.kind === 'space') spaces.add(invalidation.target.id);
              }
            }
          const keys: DiscoveryKey[] = [...accounts].map((id) => ({
            owner: 'accounts',
            kind: 'account',
            id,
            route: routeOf(id)!,
          }));
          const ids = [...subjects];
          for (let offset = 0; offset < ids.length; offset += 256) {
            const chunk = ids.slice(offset, offset + 256);
            const rows = await withConnection(
              pool,
              async (client) =>
                (
                  await client.query<{ id: string; route: number; kind: string }>(
                    `SELECT subject_id::text AS id,route,type AS kind FROM semantic.subject WHERE route >= $1 AND route < $2 AND subject_id=ANY($3::uuid[])
           UNION SELECT source_id::text,route,kind FROM search.discovery_copy WHERE prefix=$4 AND generation=$5
           AND route >= $1 AND route < $2 AND source_id=ANY($3::uuid[]) AND kind <> 'account'`,
                    [
                      partition * 16,
                      (partition + 1) * 16,
                      chunk,
                      projection.target.prefix,
                      projection.target.generation,
                    ],
                  )
                ).rows,
            );
            keys.push(...rows.map((row): DiscoveryKey => ({ owner: 'semantic', ...row })));
          }
          await projection.project(partition, keys, envelopes.at(-1)?.position ?? 0n);
          if (collections.size > 0 && projection.metadataProducers?.collection)
            await projection.projectOwner('collection', partition, [...collections]);
          if (spaces.size > 0 && projection.metadataProducers?.space)
            await projection.projectOwner('space', partition, [...spaces]);
        },
      });
    },
  };
}

/** Invoke the supplied native writer guard exactly once; this wrapper creates no authority. */
async function guardedApply(
  guard: SubjectApplyGuard | undefined,
  partition: number,
  envelopes: readonly Envelope[],
  apply: () => Promise<void>,
): Promise<void> {
  if (!guard) return apply();
  let applied: Promise<void> | undefined;
  let duplicate = false;
  let open = true;
  let guardFailure: unknown;
  let guardFailed = false;
  try {
    await guard(partition, envelopes, () => {
      if (!open) throw new Error('Subject apply guard has already returned');
      if (applied) {
        duplicate = true;
        throw new Error('Subject apply may only run once');
      }
      const running = apply();
      applied = running;
      // The guard may reject while this work is pending, so observe its rejection immediately.
      void running.catch(() => undefined);
      return running;
    });
  } catch (error) {
    guardFailed = true;
    guardFailure = error;
  } finally {
    open = false;
  }

  let applyFailure: unknown;
  let applyFailed = false;
  if (applied) {
    try {
      await applied;
    } catch (error) {
      applyFailed = true;
      applyFailure = error;
    }
  }

  if (guardFailed) throw guardFailure;
  if (duplicate || !applied) throw new Error('Subject apply guard must run apply exactly once');
  if (applyFailed) throw applyFailure;
}

/** The sole ordinary writer path, shared by finite cold population and event replay. */
export async function applySubjectKeys(
  options: Pick<
    Parameters<typeof createSubjectIndexer>[0],
    'search' | 'source' | 'listing' | 'index' | 'writer' | 'calendarFormat'
  >,
  partition: number,
  ids: readonly string[],
  obligation: bigint,
  guard?: SubjectApplyGuard,
): Promise<void> {
  if (ids.length > 1000) throw new RangeError('A public population step accepts at most 1000 keys');
  await guardedApply(guard, partition, [], async () => {
    const chunkSize = options.writer ? SEARCH_IDENTITY_WRITER_CHUNK : 256;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      if (options.writer) {
        await options.writer.write(partition, chunk, obligation);
        continue;
      }
      const snapshot = await options.source.read(partition, chunk);
      const subjects = validateIndexObservation(snapshot, partition, chunk, obligation);
      const indexIds = chunk.filter((id) => {
        const subject = subjects.get(id);
        return subject?.visibility === 'visible' && subject.redirect === null;
      });
      const counts = indexIds.length === 0 ? undefined : await options.listing.read(partition, indexIds);
      const actions = await prepareBoundedSortKeys(
        options.search,
        options.index,
        documentActions(snapshot, chunk, counts, options.calendarFormat),
      );
      await writeIndexActions(options.search, options.index, actions);
    }
  });
}
