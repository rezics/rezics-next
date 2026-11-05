import { m } from '../../paraglide/messages.js';
import type { VndbJourneySnapshot } from './controller';

/** Counts refer to observed rows; an unread page is never declared complete. */
export function VndbPendingReview({ snap }: { snap: VndbJourneySnapshot }) {
  const pending = snap.rows.filter(
    (row) =>
      row.kind === 'vn' && (!row.decision || row.decision.status === 'stale' || row.decision.status === 'failed'),
  ).length;
  const unseen = snap.total - snap.rows.length;
  if (!pending && !unseen) return null;
  return <p role="status">{m.library_vndb_rows_pending({ count: pending, unseen })}</p>;
}
