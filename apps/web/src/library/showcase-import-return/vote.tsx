import { m } from '../../paraglide/messages.js';
import type { ImportLibraryRow } from './presentation';

/** Counted caller-private native units; source scores and apply receipts never fill a missing read. */
export function ImportLibraryVote({ row, detailed = false }: { row: ImportLibraryRow; detailed?: boolean }) {
  const vote = row.vote;
  const question = row.voteQuestion;
  return (
    <div className="space-y-1 text-sm" data-vndb-native-vote={vote?.state ?? 'unavailable'}>
      <p>
        {vote?.state === 'present'
          ? m.library_vndb_score_current_set({ units: vote.units, revision: vote.revision })
          : vote?.state === 'absent'
            ? m.library_vndb_score_current_absent()
            : m.library_vndb_score_current_unavailable()}
      </p>
      {detailed && question ? (
        <p className="break-words text-xs text-muted-foreground" data-vndb-native-question={question.id}>
          {question.meaning} · {m.rating_question_revision({ revision: question.revision })} · {question.scale.min}–
          {question.scale.max}
        </p>
      ) : null}
    </div>
  );
}
