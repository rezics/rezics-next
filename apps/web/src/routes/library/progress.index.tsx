import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { progressIndexAddress } from '../../library/progress-address';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CurrentViewerProgressIndexPage } from '../../library/progress-page';
import { readCurrentViewerProgressIndex } from '../../library/progress-server';
import { progressIndexReturnSelectionFromLocationState } from '../../library/progress-start-draft-navigation';
import { subjectProgressEntryReturnFromState, subjectSlotReturnTo } from '../../library/subject-slot-return-context';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/')({
  beforeLoad: async (args) => {
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: progressIndexAddress,
  loaderDeps: ({ search }) => ({
    subjectId: search.subjectId,
    state: search.state,
    mode: search.mode,
    profileId: search.profileId,
    cursor: search.cursor,
  }),
  loader: ({ deps }) => readCurrentViewerProgressIndex({ data: deps }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_progress_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function ProgressIndexRoute() {
    const loader = Route.useLoaderData();
    const location = useLocation();
    const locale = getLocale();
    const requested = progressIndexAddress(location.search);
    const returnSelection = progressIndexReturnSelectionFromLocationState(location.state, locale);
    const subject = loader.page.selectedSubject;
    const candidate =
      returnSelection?.sourceReturnTo ??
      (subject ? subjectProgressEntryReturnFromState(location.state, subject, locale) : undefined);
    const sourceReturnTo = candidate && subject ? subjectSlotReturnTo(candidate, subject, locale) : undefined;
    return (
      <CurrentViewerProgressIndexPage
        loader={loader}
        requested={requested}
        returnSelection={returnSelection}
        sourceReturnTo={sourceReturnTo}
      />
    );
  },
});
