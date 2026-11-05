import { useMemo } from 'react';
import { EditorialContextWorkspace } from './editorial-context-view';
import { editorialContextFixture, type EditorialScenario } from '../../kernel/fake/editorial-context';
import { CandidateReview } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { AppShell } from '../../shell/shell';
import { PageHeading } from '../../shell/page-heading';
import { PatternStory } from '../../stories/page';

export function EditorialContextStory({ scenario = 'ready' }: { scenario?: EditorialScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => editorialContextFixture(scenario, locale), [scenario, locale]);
  const create = ['create', 'invalid', 'conflict', 'uncertain'].includes(scenario);
  return (
    <PatternStory path={create ? '/contexts/new' : `/contexts/${fixture.id}`} visitor="Signed In">
      <AppShell>
        <article className="mx-auto w-full max-w-4xl space-y-8">
          <PageHeading>{create ? m.editorial_create() : m.editorial_title()}</PageHeading>
          <EditorialContextWorkspace
            key={`${scenario}:${locale}`}
            locale={locale}
            transport={fixture.transport}
            {...(!create ? { id: fixture.id } : {})}
            reviewHref={(context) =>
              `${subjectHref({ id: fixture.review.id, label: 'The Art of Reading' }, locale).href}/context-review?${new URLSearchParams({ context })}`
            }
          >
            {!create && scenario !== 'global'
              ? (context) => (
                  <CandidateReview
                    id={fixture.review.id}
                    context={context}
                    locale={locale}
                    initialProperty={fixture.review.property}
                    transport={fixture.review.transport}
                  />
                )
              : undefined}
          </EditorialContextWorkspace>
        </article>
      </AppShell>
    </PatternStory>
  );
}
