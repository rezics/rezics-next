import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { ClosedErrorPage } from '../../shell/closed';
import { m } from '../../paraglide/messages.js';
import { readSpaceSetup } from '../../community/space-actions';
import { setupReadSchema } from '../../community/space-setup';
import { SpaceSetupPage } from '../../community/space-setup-page';

export const Route = createFileRoute('/realms/new')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    v.parse(setupReadSchema, typeof search.spaceId === 'string' ? { spaceId: search.spaceId } : {}),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => readSpaceSetup({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.space_setup_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  errorComponent: ClosedErrorPage,
  component: () => (
    <SpaceSetupPage
      key={Route.useSearch().spaceId ?? 'new'}
      initial={Route.useLoaderData()}
      spaceId={Route.useSearch().spaceId}
    />
  ),
});
