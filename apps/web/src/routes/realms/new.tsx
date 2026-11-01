import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { ClosedErrorPage } from '../../shell/closed';
import { m } from '../../paraglide/messages.js';
import { readSpaceSetup } from '../../community/space-actions';
import {
  captureSpaceSetupInitialAdmission,
  type SpaceSetupInitialAdmission,
} from '../../community/space-setup-lifetime';
import { setupReadSchema } from '../../community/space-setup';
import { SpaceSetupPage } from '../../community/space-setup-page';
import type { QueryClient } from '@tanstack/react-query';

type SetupReadDependencies = v.InferOutput<typeof setupReadSchema>;

/** Capture the original cache observation before the unchanged server reader starts. */
export async function loadSpaceSetupRoute(
  queryClient: QueryClient,
  deps: SetupReadDependencies,
): Promise<{ initial: Awaited<ReturnType<typeof readSpaceSetup>>; admission: SpaceSetupInitialAdmission }> {
  const admission = captureSpaceSetupInitialAdmission(queryClient);
  const initial = await readSpaceSetup({ data: deps });
  return { initial, admission };
}

export const Route = createFileRoute('/realms/new')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    v.parse(setupReadSchema, typeof search.spaceId === 'string' ? { spaceId: search.spaceId } : {}),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => loadSpaceSetupRoute(context.queryClient, deps),
  head: ({ match }) =>
    pageHead({ title: m.space_setup_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  errorComponent: ClosedErrorPage,
  component: () => {
    const { initial, admission } = Route.useLoaderData();
    return (
      <SpaceSetupPage
        key={Route.useSearch().spaceId ?? 'new'}
        initial={initial}
        admission={admission}
        spaceId={Route.useSearch().spaceId}
      />
    );
  },
});
