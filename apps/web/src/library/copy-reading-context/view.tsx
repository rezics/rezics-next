import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { withSubjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import type { CopyReadingContext as CopyReadingContextData, CopyReadingIdentity } from './types';

function destination(identity: CopyReadingIdentity, returnTo: string | undefined, locale: string): string {
  const href = subjectHref({ id: identity.id, label: identity.label }, locale).href;
  return withSubjectVisitReturn(href, returnTo ?? '', locale);
}

export function CopyReadingContextView({
  context,
  returnTo,
  locale,
}: {
  context?: CopyReadingContextData | undefined;
  returnTo?: string | undefined;
  locale: string;
}) {
  const hasDetails = !!context && (context.work.length > 0 || !!context.edition || context.facts.length > 0);
  if (!context || !hasDetails)
    return (
      <p data-slot="copy-reading-context" className="mt-2 text-sm text-muted-foreground">
        {m.library_copy_reading_context_unavailable()}
      </p>
    );

  return (
    <div data-slot="copy-reading-context" className="mt-2 space-y-1 text-sm">
      <dl className="space-y-1">
        {context.work.length ? (
          <div className="grid min-w-0 gap-x-2 sm:grid-cols-[5rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{m.subject_work()}</dt>
            <dd className="min-w-0 break-words">
              {context.work.map((work, index) => (
                <span key={work.id}>
                  {index ? ', ' : null}
                  <a
                    href={destination(work, returnTo, locale)}
                    lang={work.labelLanguage}
                    className="text-primary underline underline-offset-4"
                  >
                    {work.label}
                  </a>
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        {context.edition ? (
          <div className="grid min-w-0 gap-x-2 sm:grid-cols-[5rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{m.library_copy_edition()}</dt>
            <dd className="min-w-0 break-words">
              <a
                href={destination(context.edition, returnTo, locale)}
                lang={context.edition.labelLanguage}
                className="text-primary underline underline-offset-4"
              >
                {context.edition.label}
              </a>
            </dd>
          </div>
        ) : null}
        {context.facts.map((fact, index) => (
          <div
            key={`${fact.label}:${fact.subject?.id ?? fact.value ?? index}`}
            className="grid min-w-0 gap-x-2 sm:grid-cols-[5rem_minmax(0,1fr)]"
          >
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="min-w-0 break-words">
              {fact.subject ? (
                <a
                  href={destination(fact.subject, returnTo, locale)}
                  lang={fact.subject.labelLanguage}
                  className="text-primary underline underline-offset-4"
                >
                  {fact.subject.label}
                </a>
              ) : (
                fact.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {context.association === 'unavailable' ? (
        <p className="text-muted-foreground">{m.library_copy_reading_context_unavailable()}</p>
      ) : null}
    </div>
  );
}
