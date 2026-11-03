import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useHistoryCurrentOrigin } from '../../library/history-current-origin';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import {
  readOwnClassificationsForViewer,
  type OwnClassificationsRead,
} from '../../ratings/own-classifications/actions';
import {
  classificationFrontier,
  classificationSearch,
  OWN_CLASSIFICATIONS_OPERATION,
} from '../../ratings/own-classifications/inventory';
import { OwnClassificationsWorkspace } from '../../ratings/own-classifications/page';

const operations = [OWN_CLASSIFICATIONS_OPERATION] as const;
export const Route = createFileRoute('/library/classification-assessments')({
  validateSearch: (input: Record<string, unknown>) => {
    const frontier = classificationFrontier(input);
    return frontier ? classificationSearch(frontier) : { invalidAddress: true };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readOwnClassificationsForViewer({ data: deps.invalidAddress ? { cursor: '' } : deps }),
  head: ({ match }) =>
    pageHead({ title: m.own_classifications_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClassificationAssessmentsRoute,
});

function ClassificationAssessmentsRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const locale = getLocale();
  const origin = useHistoryCurrentOrigin(JSON.stringify([search, locale]), operations, initial.subject);
  // This mounted production boundary cannot admit rows while the generated operation is unavailable.
  return (
    <UnavailableClassificationAssessments
      key={origin.lifetime(0)}
      initial={initial}
      locale={locale}
      isCurrent={() => origin.current(0)}
    />
  );
}

function UnavailableClassificationAssessments({
  initial,
  locale,
  isCurrent,
}: {
  initial: OwnClassificationsRead;
  locale: string;
  isCurrent: () => boolean;
}) {
  const [read, update] = useState(initial);
  const frontier = read.frontier ?? { cursor: null, selected: null };
  return (
    <OwnClassificationsWorkspace
      state={read.state}
      page={null}
      frontier={frontier}
      locale={locale}
      isCurrent={isCurrent}
      onRetry={async (original) => {
        if (!isCurrent()) return;
        const result = await readOwnClassificationsForViewer({ data: classificationSearch(original) });
        if (isCurrent()) update(result);
      }}
      onNext={() => {}}
    />
  );
}
