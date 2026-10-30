import { useMemo } from 'react';
import { CandidateReview } from '../../subject/candidate-review';
import { contextFixture, type ContextScenario } from '../../kernel/fake/context-curation';
import { SubjectFrame, subjectFrame } from '../pages/subject-frame';
import { subjectTabs } from '../pages/views';
import { viewTabLabels } from '../pages/route-support';
import type { SubjectPageData } from '../pages/subject';
import recording from '../../kernel/recorded/subject-page.json';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export function ContextCurationStory({ scenario = 'inherited' }: { scenario?: ContextScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => contextFixture(scenario, locale), [scenario, locale]);
  const page = recording as unknown as SubjectPageData;
  const frame = subjectFrame(page, locale);
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8 p-4 sm:p-8">
      {frame && (
        <SubjectFrame
          frame={frame}
          locale={locale}
          unlabelled={m.subject_value_unlabelled()}
          tabs={subjectTabs(page)}
          tabLabels={viewTabLabels()}
          view="overview"
        />
      )}
      <h1 className="text-2xl font-semibold">{m.context_title()}</h1>
      <CandidateReview
        key={`${scenario}:${locale}`}
        id={fixture.id}
        context={fixture.context.id}
        initialProperty={fixture.property}
        locale={locale}
        transport={fixture.transport}
      />
    </article>
  );
}
