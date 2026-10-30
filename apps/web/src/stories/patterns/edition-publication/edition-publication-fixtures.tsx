import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { fromPlainText } from '@rezics/document';
import { EditionPublicationController } from '../../../content-editions/edition-create';
import { createNativeEditionCreateApi } from '../../../content-editions/edition-create-native';
import { editionDocumentDigest } from '../../../content-editions/edition-model';
import { EditionPublication } from '../../../content-editions/edition-create-view';
import { EditionCreateRoute } from '../../../routes/editions/new';
import { AppShell } from '../../../shell/shell';
import { deLocalizeUrl, localizeUrl } from '../../../paraglide/runtime.js';
import { setStoryRequestContext } from '../../../../.storybook/react-start';
import type { EditionMetadata } from '../../../content-editions/edition-api';
import type { ExactRevision } from '../../../threads/exact-revision';

export const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
export const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000080';
export const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
export const identity = { postId, revisionId };
export const fixedText =
  'The quiet ending leaves room for the reader to pause. This authored revision is the fixed source of the edition.';
export type PublicationExampleState = 'selection' | 'draft' | 'published' | 'refused' | 'conflict' | 'uncertain';

/** Constructed producer DTOs exercise the real typed wire adapter, never native proof or product defaults. */
export async function publicationFixture(state: PublicationExampleState) {
  const body = fromPlainText(fixedText);
  const sha256 = await editionDocumentDigest(body);
  const revision: ExactRevision = {
    id: postId,
    revisionId,
    authorId: creatorId,
    threadId: postId,
    boardId: postId,
    route: 0,
    parentId: null,
    availability: 'available',
    visibility: 'published',
    securityRevision: '1',
    createdAt: '2026-10-31T12:00:00Z',
    revisedAt: null,
    sha256,
    mediaIds: [],
    licence: 'CC-BY-SA-4.0',
    subjectIds: [subjectId],
    voteCitation: null,
    body,
  };
  let edition: EditionMetadata | null = null;
  let lost = state === 'uncertain';
  let conflict = state === 'conflict';
  const calls: { path: string; method: string; headers: Headers; body: string | null }[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const call = {
        path,
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' ? await request.text() : null,
      };
      calls.push(call);
      if (request.headers.get('authorization') !== 'Bearer story-creator')
        return Response.json({ code: 'forbidden' }, { status: 403 });
      if (path === `/v1/posts/${postId}/revisions/${revisionId}`) return Response.json({ post: revision });
      if (path === '/v1/viewerActions') {
        const resource = JSON.parse(call.body!).resources[0];
        return Response.json({
          resources: [
            {
              ...resource,
              viewerActions: [
                {
                  action: resource.type === 'content.post' ? 'post:revise' : 'edition:sell',
                  operations: [resource.type === 'content.post' ? 'post.revise' : 'content_edition.publish'],
                },
              ],
            },
          ],
        });
      }
      if (path === `/v1/subjects/${subjectId}`) return Response.json({ subject: { id: subjectId } });
      if (path === '/v1/contentEditions' && request.method === 'POST') {
        edition ??= {
          editionId,
          editionRevision: '1',
          state: 'draft',
          targetSubjectId: subjectId,
          creatorAccountId: creatorId,
          revisionId,
          sha256,
          licence: revision.licence,
        };
        if (lost) {
          lost = false;
          throw new Error('Constructed lost creation response');
        }
        return Response.json({ editionId, editionRevision: edition.editionRevision }, { status: 201 });
      }
      if (path === `/v1/contentEditions/${editionId}:publish` && edition) {
        if (state === 'refused') return Response.json({ code: 'forbidden' }, { status: 403 });
        if (conflict) {
          conflict = false;
          edition = { ...edition, editionRevision: '2' };
        }
        if (request.headers.get('if-match') !== `"${edition.editionRevision}"`)
          return Response.json({ code: 'precondition_failed' }, { status: 412 });
        edition = { ...edition, state: 'published', editionRevision: String(Number(edition.editionRevision) + 1) };
        return Response.json({ editionId, editionRevision: edition.editionRevision });
      }
      if (path === `/v1/contentEditions/${editionId}` && edition) return Response.json(edition);
      throw new Error(`Unexpected publication fixture request: ${request.method} ${path}`);
    },
    { preconnect() {} },
  );
  const api = createNativeEditionCreateApi('https://kernel.example', 'Bearer story-creator', creatorId, fetcher);
  const controller = new EditionPublicationController(api);
  await controller.select(identity);
  if (state !== 'selection') {
    controller.chooseSubject(subjectId);
    await controller.create();
    if (state === 'published' || state === 'refused' || state === 'conflict') await controller.publish();
  }
  return { api, controller, calls };
}

function PublicationRouteExample({ fixture }: { fixture: Awaited<ReturnType<typeof publicationFixture>> }) {
  const url = localizeUrl(new URL(`/editions/new?${new URLSearchParams(identity)}`, 'https://site.example'));
  const entry = url.pathname + url.search;
  setStoryRequestContext({ visitor: 'Signed In', url: entry });
  const { router, queryClient } = useMemo(() => {
    const queryClient = new QueryClient();
    const root = createRootRoute({
      component: () => (
        <AppShell>
          <Outlet />
        </AppShell>
      ),
    });
    const edition = createRoute({
      getParentRoute: () => root,
      path: '/editions/new',
      validateSearch: () => identity,
      component: () => <EditionCreateRoute api={fixture.api} controller={fixture.controller} />,
    });
    const router = createRouter({
      routeTree: root.addChildren([edition]),
      history: createMemoryHistory({ initialEntries: [entry] }),
      context: { queryClient, credentialMode: 'session' },
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    return { router, queryClient };
  }, [entry, fixture]);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

export function EditionPublicationExample({
  state = 'selection',
  shell = false,
}: {
  state?: PublicationExampleState;
  shell?: boolean;
}) {
  const [fixture, setFixture] = useState<Awaited<ReturnType<typeof publicationFixture>> | null>(null);
  useEffect(() => {
    let active = true;
    setFixture(null);
    void publicationFixture(state).then((result) => {
      if (active) setFixture(result);
    });
    return () => {
      active = false;
    };
  }, [state]);
  if (!fixture) return null;
  return shell ? (
    <PublicationRouteExample fixture={fixture} />
  ) : (
    <div className="p-4 sm:p-8">
      <EditionPublication controller={fixture.controller} />
    </div>
  );
}
