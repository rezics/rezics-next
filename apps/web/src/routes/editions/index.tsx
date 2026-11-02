import { createFileRoute } from '@tanstack/react-router';
import { creatorEditionsSearch } from '../../content-editions/creator-editions';
import { readCreatorEditions } from '../../content-editions/creator-editions-read';
import { CreatorEditionsView } from '../../content-editions/creator-editions-view';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/editions/')({
  beforeLoad: requireSignedIn,
  staticData: { sessionReread: true },
  validateSearch: creatorEditionsSearch,
  loaderDeps: ({ search }) => creatorEditionsSearch(search),
  loader: ({ deps, preload }) => (preload ? { kind: 'loading' as const } : readCreatorEditions({ data: deps })),
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  head: ({ match }) =>
    pageHead({ title: m.creator_editions_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorEditionsView page={{ kind: 'loading' }} />,
  errorComponent: CreatorEditionsErrorRoute,
  component: CreatorEditionsRoute,
});

function CreatorEditionsErrorRoute() {
  const { cursor } = Route.useSearch();
  return <CreatorEditionsView page={{ kind: 'unavailable' }} {...(cursor ? { cursor } : {})} />;
}

export function CreatorEditionsRoute() {
  const { cursor } = Route.useSearch();
  return <CreatorEditionsView page={Route.useLoaderData()} {...(cursor ? { cursor } : {})} />;
}
