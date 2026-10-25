import type { Pool } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import type { SubjectListingSource } from '../search/source.ts';
import readCounts from './listing-counts.sql';

/** Read public Collection counts from `library.subject_listing` for one subject partition. */
export function subjectListingSource(pool: Pool): SubjectListingSource {
  return {
    async read(partition, ids) {
      for (const id of ids) {
        const route = routeOf(id);
        if (route === null) throw new TypeError('Subject id must be a routable UUID');
        if (partitionOf(route) !== partition) throw new RangeError('Subject id routes to a different partition');
      }
      const rows = await readCounts.run(pool, { partition_no: partition, subject_ids: [...ids] });
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.subjectId, row.publicCollectionCount);
      return counts;
    },
  };
}
