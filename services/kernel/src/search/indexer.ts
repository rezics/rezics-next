import type { Pool } from 'pg';
import { projectBatch, type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { bulkLines, documentActions } from './document.ts';
import type { OpenSearch } from './opensearch.ts';
import { subjectPartition, type SubjectListingSource, type SubjectSource } from './source.ts';
import { IndexWriteError } from './write-actions.ts';

export { IndexWriteError } from './write-actions.ts';

type BulkResponse = { items?: Record<string, { status?: number; error?: { type?: string } }>[] };

/** Internal composition only: admission must reject or await the same real apply exactly once. */
export type SubjectApplyGuard = (
  partition: number,
  envelopes: readonly Envelope[],
  apply: () => Promise<void>,
) => Promise<void>;

export function createSubjectIndexer(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  index: string;
  consumer: string;
  aroundApply?: SubjectApplyGuard;
}): Relay {
  return {
    consumer: options.consumer,
    run(partition) {
      return projectBatch(options.pool, {
        consumer: options.consumer,
        partition,
        apply: async (envelopes) => {
          const apply = async () => {
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const envelope of envelopes) {
              for (const event of envelope.events) {
                if (
                  (!event.type.startsWith('com.rezics.subject.') &&
                    event.type !== 'com.rezics.library.subject.listed.v1') ||
                  !event.subject ||
                  seen.has(event.subject)
                )
                  continue;
                if (subjectPartition(event.subject) !== partition) continue;
                seen.add(event.subject);
                ids.push(event.subject);
              }
            }
            if (ids.length === 0) return;

            const snapshot = await options.source.read(partition, ids);
            const subjects = new Map<string, (typeof snapshot.subjects)[number]>();
            for (const subject of snapshot.subjects) {
              if (subjectPartition(subject.id) !== snapshot.partition)
                throw new RangeError('Snapshot contains a subject outside its partition');
              subjects.set(subject.id, subject);
            }
            const indexIds = ids.filter((id) => {
              const subject = subjects.get(id);
              return subject?.visibility === 'visible' && subject.redirect === null;
            });
            const counts = indexIds.length === 0 ? undefined : await options.listing.read(partition, indexIds);
            const actions = await prepareBoundedSortKeys(
              options.search,
              options.index,
              documentActions(snapshot, ids, counts),
            );
            const response = await options.search.bulk<BulkResponse>(bulkLines(options.index, actions), {
              query: { refresh: 'wait_for' },
            });
            const results = response.items ?? [];
            const failures = results.filter((item, index) => {
              const operation = Object.values(item)[0];
              const status = operation?.status;
              if (status === 200 || status === 201) return false;
              if (status === 409 && operation?.error?.type === 'version_conflict_engine_exception') return false;
              if (status === 404 && actions[index]?.op === 'delete') return false;
              return true;
            });
            if (results.length !== actions.length || failures.length > 0)
              throw new IndexWriteError(failures.length ? failures : results);
          };
          if (!options.aroundApply) return apply();
          let applied: Promise<void> | undefined;
          let duplicate = false;
          let open = true;
          try {
            await options.aroundApply(partition, envelopes, () => {
              if (!open) throw new Error('Subject apply guard has already returned');
              if (applied) {
                duplicate = true;
                throw new Error('Subject apply may only run once');
              }
              applied = apply();
              return applied;
            });
          } finally {
            open = false;
          }
          if (duplicate || !applied) throw new Error('Subject apply guard must run apply exactly once');
          await applied;
        },
      });
    },
  };
}
