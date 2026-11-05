import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import type { Application, Result, Review, ReviewInput } from './native';

export function Evidence({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <dt className="font-medium">{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}
export function RecoveryReview({ review, operands }: { review: Review; operands: ReviewInput }) {
  return (
    <section className="space-y-4" aria-label={m.library_archive_progress_review()}>
      <h2 className="text-xl font-semibold">{m.library_archive_progress_review()}</h2>
      <p>
        {review.reviewId} · {review.recovery}
      </p>
      <p>{m.library_archive_progress_review_help()}</p>
      <dl className="space-y-3">
        <Fact title={m.library_archive_progress_occurrences()}>
          {review.sourceSessionId} → {review.subjectId}
        </Fact>
        <Fact title={m.library_archive_progress_pair()}>
          {review.current.mode} · {review.current.unit}
          <Evidence value={review.current.profile} />
        </Fact>
        {review.measures.map((measure) => (
          <Fact key={measure.sourceUnit} title={measure.sourceUnit}>
            <p>{measure.currentUnit ?? m.library_archive_progress_omit()}</p>
            <p>
              {measure.sourceAmount ?? m.library_progress_measure_absent()} · {measure.amount}
            </p>
            <p>
              {m.library_progress_measure_total({ value: measure.sourceTotal ?? m.library_progress_measure_absent() })}{' '}
              · {measure.total}
            </p>
          </Fact>
        ))}
        <Fact title={m.library_archive_progress_units()}>
          <ul>
            {review.completedUnits.map((unit) => (
              <li key={unit.unitId}>
                {unit.unitId} · {unit.admission}
              </li>
            ))}
          </ul>
        </Fact>
        <Fact title={m.library_archive_progress_unsupported()}>
          <ul>
            {review.unsupported.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          <Evidence value={review.unsupportedHistoricalDates} />
        </Fact>
      </dl>
      <details>
        <summary className="min-h-11 cursor-pointer py-3">{m.library_archive_progress_exact()}</summary>
        <Evidence value={{ reviewId: review.reviewId, operands }} />
      </details>
    </section>
  );
}
export function RecoveryResult({
  application,
  result,
  pending,
}: {
  application: Application | null;
  result: Result | null;
  pending: boolean;
}) {
  if (!application && !result) return null;
  const outcome = result?.application ?? application;
  const unreconciled = pending || outcome?.state === 'recoverable' || outcome?.state === 'applying';
  return (
    <section className="space-y-3" aria-label={m.library_archive_progress_result()}>
      <h2 className="text-xl font-semibold">{m.library_archive_progress_result()}</h2>
      <p>
        {outcome?.state} · {outcome?.acceptedSteps}
      </p>
      {unreconciled ? (
        <p role="status">{m.library_archive_progress_recoverable()}</p>
      ) : (
        <>
          <p>{m.library_archive_progress_accepted()}</p>
          {result?.progressSession ? (
            <>
              <p>
                {result.progressSession.id} · {result.progressSession.state}
              </p>
              <Evidence value={result.progressSession} />
              <Evidence value={result.completedEpisodes} />
            </>
          ) : (
            <p>{m.library_archive_progress_no_result()}</p>
          )}
        </>
      )}
    </section>
  );
}
