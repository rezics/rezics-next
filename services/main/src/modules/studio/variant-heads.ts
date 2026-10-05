import type { ContentCore } from '../../../../content/src/core.ts';
import { WorkReadExpired } from '../work/read-session.ts';

/** One repeat of the same indexed, at-most-twenty-item page. Content writes on
 * other resources do not invalidate these heads or this continuation. */
export async function fenceStudioVariantHeads(content: Pick<ContentCore, 'listVariantHeads'>, resource: string,
  after: string, limit: number, listed: Awaited<ReturnType<ContentCore['listVariantHeads']>>) {
  const current = await content.listVariantHeads(resource, after, limit);
  if (JSON.stringify(current) !== JSON.stringify(listed)) {
    // An expired Content basis returns the read's 409, rather than exhausting
    // the graph envelope's retries on an unrelated owner sequence.
    throw new WorkReadExpired('Content variants changed');
  }
}
