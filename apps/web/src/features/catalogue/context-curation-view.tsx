import type { CandidateRead } from '../../subject/candidates';
import { CandidateValue, pageText } from '../pages/data';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { contextOutcome } from './context-curation';

export function ContextComparisonView({
  read,
  property,
  locale,
}: {
  read: Extract<CandidateRead, { ok: true }>;
  property: string;
  locale: string;
}) {
  const review = read.contextReview;
  if (!review) return null;
  const options = { locale: locale as never };
  const state = contextOutcome(review, property, review.adoption?.mode);
  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h3 className="text-lg font-semibold">
          {pageText(review.context.labels, locale).text || m.context_unnamed({}, options)}
        </h3>
        <p>{review.context.kind === 'global' ? m.context_global({}, options) : m.context_community({}, options)}</p>
        <p className="text-sm text-muted-foreground">{m.context_authority({}, options)}</p>
        <a
          className="underline underline-offset-4"
          href={
            subjectHref(
              { id: read.public.subject.id, label: pageText(read.public.subject.labels, locale).text },
              locale,
            ).href
          }
        >
          {m.candidate_view_public({}, options)}
        </a>
      </header>
      {property && (
        <>
          <p role="status">
            {state === 'unresolved'
              ? m.context_unresolved({}, options)
              : state === 'suppressed'
                ? m.context_suppressed({}, options)
                : state === 'replaced'
                  ? m.context_replaced({}, options)
                  : m.context_inherited({}, options)}
          </p>
          {review.slot && <p className="text-sm text-muted-foreground">{m.context_relation_resolution({}, options)}</p>}
          {review.slot && review.reading.subject.resolution[property] === 'unresolved' && (
            <p>{m.context_unresolved({}, options)}</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              {
                title: m.context_global_values({}, options),
                statements: review.inherited,
                related: read.public.related,
              },
              {
                title: m.context_selected_values({}, options),
                statements: review.selected,
                related: review.reading.related,
              },
            ].map(({ title, statements, related }) => (
              <section key={title} className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3">
                <h4 className="font-semibold">{title}</h4>
                {statements.length ? (
                  statements.map((statement) => (
                    <div key={statement.id}>
                      <CandidateValue snak={statement} related={related} locale={locale} />
                    </div>
                  ))
                ) : (
                  <p>{m.context_no_values({}, options)}</p>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
