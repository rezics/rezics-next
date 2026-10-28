import type { Pool } from 'pg';
import { projectBatch } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { bulkLines, documentActions } from './document.ts';
import type { OpenSearch } from './opensearch.ts';
import { subjectPartition, type SubjectListingSource, type SubjectSource } from './source.ts';
import { IndexWriteError } from './write-actions.ts';

export { IndexWriteError } from './write-actions.ts';

type BulkResponse = { items?: Record<string, { status?: number; error?: { type?: string } }>[] };

export function createSubjectIndexer(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  index: string;
  consumer: string;
}): Relay {
  return {
    consumer: options.consumer,
    run(partition) {
      return projectBatch(options.pool, {
        consumer: options.consumer,
        partition,
        apply: async (envelopes) => {
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
          const actions = documentActions(snapshot, ids, counts);
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
        },
      });
    },
  };
}
