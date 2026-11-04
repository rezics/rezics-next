import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { withSubjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import type { CopyReadingContext, CopyReadingIdentity } from './types';

function destination(identity: CopyReadingIdentity, returnTo: string | undefined, locale: string): string {
  const href = subjectHref({ id: identity.id, label: identity.label }, locale).href;
  return withSubjectVisitReturn(href, returnTo ?? '', locale);
}

function stateLabel(context: CopyReadingContext | undefined) {
  switch (context?.state ?? 'unavailable') {
    case 'available':
      return m.library_copy_reading_context_available();
    case 'unsupported':
      return m.library_copy_reading_context_unsupported();
    case 'scope':
      return m.library_copy_reading_context_scope();
    case 'withheld':
      return m.library_copy_reading_context_withheld();
    case 'missing':
      return m.library_copy_reading_context_missing();
    case 'unavailable':
      return m.library_copy_reading_context_unavailable();
  }
}

export function CopyReadingContextView({
  context,
  returnTo,
  locale,
}: {
  context?: CopyReadingContext | undefined;
  returnTo?: string | undefined;
  locale: string;
}) {
  const work = context?.state === 'available' ? context.work : [];
  const facts = context?.state === 'available' || context?.state === 'unsupported' ? context.facts : [];

  return (
    <div data-slot="copy-reading-context" className="mt-2 space-y-1 text-sm">
      <p className="text-muted-foreground">{stateLabel(context)}</p>
      {work.length || facts.length ? (
        <dl className="space-y-1">
          {work.length ? (
            <div className="grid min-w-0 gap-x-2 sm:grid-cols-[5rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{m.subject_work()}</dt>
              <dd className="min-w-0 break-words">
                {work.map((identity, index) => (
                  <span key={`${identity.id}:${index}`}>
                    {index ? ', ' : null}
                    <a
                      href={destination(identity, returnTo, locale)}
                      lang={identity.labelLanguage}
                      className="text-primary underline underline-offset-4"
                    >
                      {identity.label}
                    </a>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {facts.map((fact, index) => (
            <div key={`${fact.property}:${fact.subject?.id ?? fact.text}:${index}`} className="grid min-w-0 gap-x-2 sm:grid-cols-[5rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 break-words">
                {fact.subject ? (
                  <a
                    href={destination(fact.subject, returnTo, locale)}
                    lang={fact.subject.labelLanguage}
                    className="text-primary underline underline-offset-4"
                  >
                    {fact.text}
                  </a>
                ) : (
                  <span lang={fact.language}>{fact.text}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
