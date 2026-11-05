import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
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
    <ContentItemFrame
      as="div"
      className="min-w-0 space-y-4 p-3 [overflow-wrap:anywhere] sm:p-4"
      data-context-comparison
    >
      <header className="space-y-2">
        <ContentItemHeading level={3} className="text-lg font-semibold">
          {pageText(review.context.labels, locale).text || m.context_unnamed({}, options)}
        </ContentItemHeading>
        <p>{review.context.kind === 'global' ? m.context_global({}, options) : m.context_community({}, options)}</p>
        <p className="text-sm text-muted-foreground">{m.context_authority({}, options)}</p>
        <a
          className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal break-words py-2 underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
              <section key={title} className="min-w-0">
                <ContentItemFrame as="div" className="min-w-0 space-y-2 p-3" data-context-values>
                  <ContentItemHeading level={4} className="font-semibold">
                    {title}
                  </ContentItemHeading>
                  {statements.length ? (
                    statements.map((statement) => (
                      <div key={statement.id}>
                        <CandidateValue snak={statement} related={related} locale={locale} />
                      </div>
                    ))
                  ) : (
                    <p>{m.context_no_values({}, options)}</p>
                  )}
                </ContentItemFrame>
              </section>
            ))}
          </div>
        </>
      )}
    </ContentItemFrame>
  );
}
