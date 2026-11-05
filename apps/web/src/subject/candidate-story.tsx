import { useEffect, useMemo } from 'react';
import { CandidateReview } from './candidate-review';
import { candidateFixture, type CandidateScenario } from '../kernel/fake/subject-candidates';
import { getLocale } from '../paraglide/runtime';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import recording from '../kernel/recorded/subject-page.json';

export function CandidateStory({
  scenario = 'ready',
  page = false,
  onRequests,
}: {
  scenario?: CandidateScenario;
  page?: boolean;
  onRequests?: (calls: Readonly<ReturnType<typeof candidateFixture>['calls']>) => void;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => candidateFixture(scenario, locale), [scenario, locale]);
  useEffect(() => {
    onRequests?.(fixture.calls);
  }, [fixture, onRequests]);
  const region = (
    <CandidateReview key={`${scenario}:${locale}`} id={fixture.id} locale={locale} transport={fixture.transport} />
  );
  const publicPage = structuredClone(recording) as unknown as SubjectPageData;
  if (page)
    return (
      <SubjectPage
        page={publicPage}
        locale={locale}
        messages={subjectPageMessages()}
        tabs={subjectTabs(publicPage)}
        tabLabels={viewTabLabels()}
        curation={region}
      />
    );
  return <div className="mx-auto max-w-4xl p-4 sm:p-8">{region}</div>;
}
