import { requireSignedIn } from '../../session/guard';
import { prepareExposure } from '../../kernel/exposure';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { progressIndexAddress } from '../../library/progress-address';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CurrentViewerProgressIndexPage } from '../../library/progress-page';
import { readCurrentViewerProgressIndex } from '../../library/progress-server';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/progress/')({
  beforeLoad: async (args) => {
    await requireSignedIn(args);
    await prepareExposure(args.context.queryClient);
  },
  validateSearch: progressIndexAddress,
  loaderDeps: ({ search }) => ({ subjectId: search.subjectId, cursor: search.cursor }),
  loader: ({ deps }) => readCurrentViewerProgressIndex({ data: deps }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_progress_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function ProgressIndexRoute() {
    return (
      <CurrentViewerProgressIndexPage
        loader={Route.useLoaderData()}
        requested={progressIndexAddress(useLocation().search)}
      />
    );
  },
});
