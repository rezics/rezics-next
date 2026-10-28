import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { readCuration } from '../../features/pages/curate-actions';
import { CurationView } from '../../features/pages/curate-view';

export const Route = createFileRoute('/curate/presentation')({
  beforeLoad: requireSignedIn,
  loader: () => readCuration(),
  head: ({ match }) =>
    pageHead({ title: 'Curate presentation', robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: PresentationCurationPage,
});

function PresentationCurationPage() {
  const initial = Route.useLoaderData();
  return <CurationView initial={initial} />;
}
