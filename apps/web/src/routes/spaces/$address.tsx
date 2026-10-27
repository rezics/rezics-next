import { createFileRoute } from '@tanstack/react-router';
import { readSpacePage } from '../../community/space-actions';
import { SpacePage } from '../../community/space-page';
import { m } from '../../paraglide/messages.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/spaces/$address')({
  loader: ({ params }) => readSpacePage({ data: { address: params.address } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.space.title ?? m.not_found_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  return <SpacePage page={Route.useLoaderData()} />;
}
