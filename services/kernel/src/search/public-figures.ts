import type { Pool } from 'pg';
import { readPublicFigureViews, type PublicFigureView } from '../rating/public-figure-http.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SearchHit } from './hits.ts';

export type PublicSearchHit = SearchHit & { figure: PublicFigureView };

/** Project only kept hits, on the backend that owns their native anchor partitions. */
export async function publicHitFigures(pool: Pool, hits: readonly SearchHit[]): Promise<PublicSearchHit[]> {
  const ids = [...new Set(hits.map((hit) => hit.id))];
  if (ids.length > 256) throw new RangeError('Public hit figures accept at most 256 subjects');
  if (ids.length === 0) return [];
  // One owned snapshot across this backend's partitions: two owner statements
  // (question + full-key figures/pending), plus BEGIN, timeout and COMMIT. The
  // connection is released before freshness, other backend or engine work.
  const views = await withReadTransaction(pool, (client) => readPublicFigureViews(client, ids));
  if (views === null) throw new Error('The standard public figure question is unavailable');
  return hits.map((hit) => {
    const view = views.get(hit.id);
    if (!view) throw new Error('The public figure reader omitted a kept subject');
    return { ...hit, figure: view.figure };
  });
}
