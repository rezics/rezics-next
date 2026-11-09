import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { EditionMetadata } from '../../../content-editions/edition-api';
import {
  creatorEditionsSearch,
  loadCreatorEditions,
  type CreatorEditionsPage,
} from '../../../content-editions/creator-editions';
import { CreatorEditionsView } from '../../../content-editions/creator-editions-view';
import { CreatorEditionsRoute } from '../../../content-editions/creator-editions-route';
import { AppShell } from '../../../shell/shell';
import { deLocalizeUrl, localizeUrl } from '../../../paraglide/runtime.js';
import { setStoryRequestContext } from '../../../../.storybook/react-start';

/** Constructed closed producer DTOs for interface review; these are not native execution evidence. */
export const creatorEditionFixture: EditionMetadata = {
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000080',
  editionRevision: '1',
  state: 'draft',
  targetSubjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
  creatorAccountId: '0192f3a0-6c1e-7b2a-9d4e-000000000090',
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-SA-4.0',
  identity: {
    subject: {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
      kind: 'available',
      label: { value: '夜の航路', language: 'ja' },
    },
    revisionCreatedAt: '2026-10-31T12:00:00.000Z',
  },
};
export const publishedEditionFixture: EditionMetadata = {
  ...creatorEditionFixture,
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000081',
  editionRevision: '2',
  state: 'published',
};
export const withdrawnEditionFixture: EditionMetadata = {
  ...creatorEditionFixture,
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000082',
  editionRevision: '3',
  state: 'withdrawn',
};
export type CreatorEditionsExampleState =
  | 'editions'
  | 'sparse'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'loading'
  | 'sign-in';
export function creatorEditionsFixture(state: CreatorEditionsExampleState): CreatorEditionsPage {
  if (state === 'editions')
    return {
      kind: 'ready',
      editions: [creatorEditionFixture, publishedEditionFixture, withdrawnEditionFixture],
      next: 'constructed-next-page',
    };
  if (state === 'sparse') return { kind: 'ready', editions: [], next: 'constructed-next-page' };
  if (state === 'empty') return { kind: 'ready', editions: [], next: null };
  return { kind: state };
}

export function CreatorEditionsExample({
  state = 'editions',
  shell = false,
}: {
  state?: CreatorEditionsExampleState;
  shell?: boolean;
}) {
  const page = creatorEditionsFixture(state);
  const cursor = state === 'sparse' ? 'constructed-current-page' : undefined;
  const url = localizeUrl(new URL(`/editions${cursor ? `?cursor=${cursor}` : ''}`, 'https://site.example'));
  const entry = url.pathname + url.search;
  setStoryRequestContext({ visitor: state === 'sign-in' ? 'Signed Out' : 'Signed In', url: entry });
  const { router, queryClient } = useMemo(() => {
    const queryClient = new QueryClient();
    const root = createRootRoute({
      component: () => (
        <AppShell>
          <Outlet />
        </AppShell>
      ),
    });
    const route = createRoute({
      getParentRoute: () => root,
      path: '/editions/',
      validateSearch: creatorEditionsSearch,
      loaderDeps: ({ search }) => search,
      loader: async () =>
        page.kind === 'ready'
          ? loadCreatorEditions(
              {
                get: async () => ({ status: 200, data: { editions: page.editions, next: page.next } }),
              },
              creatorEditionFixture.creatorAccountId,
              'Bearer constructed-story-creator',
              cursor ? { cursor } : {},
            )
          : page,
      component: CreatorEditionsRoute,
    });
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [entry] }),
      context: { queryClient, credentialMode: 'session' },
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    return { router, queryClient };
  }, [entry, state]);
  return shell ? (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  ) : (
    <div className="p-4 sm:p-8">
      <CreatorEditionsView page={page} {...(cursor ? { cursor } : {})} />
    </div>
  );
}
