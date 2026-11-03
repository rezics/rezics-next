import { createFileRoute } from '@tanstack/react-router';
import { useHistoryCurrentOrigin } from '../../library/history-current-origin';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { readOwnClassificationsForViewer } from '../../ratings/own-classifications/actions';
import { useLibraryWorkspaceAdmission } from '../../library/library-workspace-admission';
import { useClassificationAddress } from '../../ratings/own-classifications/address';
import { UnavailableClassificationsReader } from '../../ratings/own-classifications/reader';
import {
  classificationFrontier,
  classificationSearch,
  OWN_CLASSIFICATIONS_OPERATION,
} from '../../ratings/own-classifications/inventory';

const operations = [OWN_CLASSIFICATIONS_OPERATION] as const;
export const Route = createFileRoute('/library/classification-assessments')({
  validateSearch: (input: Record<string, unknown>) => {
    const frontier = classificationFrontier(input);
    return frontier ? classificationSearch(frontier) : { invalidAddress: true };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readOwnClassificationsForViewer({ data: 'invalidAddress' in deps ? { cursor: '' } : deps }),
  head: ({ match }) =>
    pageHead({ title: m.own_classifications_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClassificationAssessmentsRoute,
});

function ClassificationAssessmentsRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const locale = getLocale();
  const frontier = 'invalidAddress' in search ? null : classificationFrontier(search);
  const address = useClassificationAddress(frontier, locale);
  const admission = useLibraryWorkspaceAdmission(operations).value;
  const origin = useHistoryCurrentOrigin(address.key, operations, initial.subject);
  const state = !frontier
    ? 'invalid-address'
    : origin.session.state === 'signed-out'
      ? 'signed-out'
      : admission.rejected || (origin.authoritative && origin.retained[0] && !admission.allowed[0])
        ? 'denied'
        : null;
  // This mounted production boundary cannot admit rows while the generated operation is unavailable.
  return (
    <UnavailableClassificationsReader
      key={JSON.stringify([origin.lifetime(0), origin.epoch(0)])}
      initial={initial}
      frontier={frontier ?? { cursor: null, selected: null }}
      locale={locale}
      subject={origin.subject}
      state={state}
      isCurrent={() => address.isCurrent() && origin.current(0)}
      read={(original) => readOwnClassificationsForViewer({ data: classificationSearch(original) })}
    />
  );
}
