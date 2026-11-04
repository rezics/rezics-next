import { RevisionProvenance } from '../threads/revision-provenance-view';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { SearchReviewContext } from './review-context';

/** Published revision evidence only. Search never requests an author's own vote. */
export function ReviewContextDetails({ context, locale }: { context: SearchReviewContext; locale: string }) {
  const options = { locale: locale as Locale };
  if (context.state !== 'available') return <p>{m.post_history_score_failed({}, options)}</p>;
  const citation = context.citation;
  if (citation.state !== 'available')
    return (
      <p>
        {citation.state === 'absent'
          ? m.thread_provenance_unscored({}, options)
          : m.post_history_score_concealed({}, options)}
      </p>
    );
  return (
    <div className="min-w-0 space-y-2" data-review-citation="historical">
      <RevisionProvenance
        revision={{ licence: '', subjectIds: [], voteCitation: citation.recorded }}
        subjects={[]}
        review
        showLicence={false}
      />
      <p className="text-sm text-muted-foreground">{m.search_review_historical_question_unavailable({}, options)}</p>
    </div>
  );
}
