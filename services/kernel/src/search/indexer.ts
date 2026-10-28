import type { Pool } from 'pg';
import { projectBatch, type Envelope } from '../events/log.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import type { Relay } from '../events/relays.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions } from './document.ts';
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
              if (envelope.partition !== partition) continue;
              for (const event of envelope.events) {
                if (
                  event.type.startsWith('com.rezics.subject.') ||
                  event.type === 'com.rezics.library.subject.listed.v1'
                ) {
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

            for (let offset = 0; offset < ids.length; offset += 256) {
              const chunk = ids.slice(offset, offset + 256);
              const snapshot = await options.source.read(partition, chunk);
              const subjects = new Map<string, (typeof snapshot.subjects)[number]>();
              for (const subject of snapshot.subjects) {
                if (subjectPartition(subject.id) !== snapshot.partition)
                  throw new RangeError('Snapshot contains a subject outside its partition');
                subjects.set(subject.id, subject);
              }
              const indexIds = chunk.filter((id) => {
                const subject = subjects.get(id);
                return subject?.visibility === 'visible' && subject.redirect === null;
              });
              const counts = indexIds.length === 0 ? undefined : await options.listing.read(partition, indexIds);
              const actions = await prepareBoundedSortKeys(
                options.search,
                options.index,
                documentActions(snapshot, chunk, counts),
              );
              await writeIndexActions(options.search, options.index, actions);
            }
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
