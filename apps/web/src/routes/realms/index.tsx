import { createFileRoute } from '@tanstack/react-router';
import { MyRealmsPageView } from '../../community/my-realms-page';
import { readMyRealmsPage } from '../../community/space-actions';
import { m } from '../../paraglide/messages.js';
import { ClosedErrorPage } from '../../shell/closed';

export const Route = createFileRoute('/realms/')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' && search.cursor ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readMyRealmsPage({ data: deps.cursor ? { cursor: deps.cursor } : {} }),
  head: () => ({ meta: [{ title: m.realms_heading() }] }),
  errorComponent: ClosedErrorPage,
  component: () => <MyRealmsPageView page={Route.useLoaderData()} />,
});
