import { createFileRoute } from '@tanstack/react-router';
import { readCuration } from '../../features/pages/curate-actions';
import { CurationView } from '../../features/pages/curate-view';

export const Route = createFileRoute('/curate/presentation')({
  loader: () => readCuration(),
  head: () => ({ meta: [{ title: 'Curate presentation' }] }),
  component: PresentationCurationPage,
});

function PresentationCurationPage() {
  const initial = Route.useLoaderData();
  return <CurationView initial={initial} />;
}
