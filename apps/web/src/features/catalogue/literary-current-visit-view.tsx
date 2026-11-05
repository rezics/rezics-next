import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';
import { ViewHeading } from '../pages/view-heading';
import type { LiteraryVisitInput } from './literary-current-visit';

/** Refusal happens before the editor, its advice and candidate work mount. */
export function LiteraryCurrentVisitAdmission({
  input,
  locale,
  globalHref,
  children,
}: {
  input: LiteraryVisitInput;
  locale: string;
  globalHref: string;
  children: ReactNode;
}) {
  if (input.kind === 'direct' || (input.kind === 'visit' && input.visit.context === candidateContext)) return children;
  const o = { locale: locale as never };
  return (
    <article className="mx-auto min-w-0 max-w-4xl space-y-5 p-6 [overflow-wrap:anywhere]">
      <ViewHeading label={m.literary_title({}, o)} headingClassName="font-sans" />
      <p role="alert">
        {input.kind === 'invalid' ? m.literary_visit_invalid({}, o) : m.literary_visit_global_only({}, o)}
      </p>
      <nav className="flex flex-wrap gap-3">
        {input.kind === 'visit' && (
          <a
            className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
            href={input.visit.source}
          >
            {m.literary_visit_return({}, o)}
          </a>
        )}
        <a
          className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
          href={globalHref}
        >
          {m.literary_visit_global({}, o)}
        </a>
      </nav>
    </article>
  );
}
