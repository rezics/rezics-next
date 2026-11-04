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
import { fromPlainText, parseDocument } from '@rezics/document';
import { editionCreateSearch, EditionPublicationController } from '../../../content-editions/edition-create';
import { createNativeEditionCreateApi } from '../../../content-editions/edition-create-native';
import { editionDocumentDigest } from '../../../content-editions/edition-model';
import { EditionPublication } from '../../../content-editions/edition-create-view';
import { EditionCreateRoute } from '../../../routes/editions/new';
import { AppShell } from '../../../shell/shell';
import { deLocalizeUrl, localizeUrl } from '../../../paraglide/runtime.js';
import { setStoryRequestContext } from '../../../../.storybook/react-start';
import type { EditionMetadata, EditionSubjectIdentity } from '../../../content-editions/edition-api';
import type { ExactRevision } from '../../../threads/exact-revision';

export const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
export const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000080';
export const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
export const identity = { postId, revisionId };
export const fixedText =
  'The quiet ending leaves room for the reader to pause. This authored revision is the fixed source of the edition.';
export const imageAlt = 'An illustration accompanying the fixed source.';
export type PublicationExampleState =
  | 'selection'
  | 'image-preview-unavailable'
  | 'draft'
  | 'published'
  | 'refused'
  | 'conflict'
  | 'uncertain'
  | 'resumed-draft'
  | 'reloaded-published'
  | 'resumed-conflict'
  | 'uncertain-publish';

/** Constructed producer DTOs exercise the real typed wire adapter, never native proof or product defaults. */
export async function publicationFixture(state: PublicationExampleState) {
  const text = fromPlainText(fixedText);
  const imageId = '0192f3a0-6c1e-7b2a-9d4e-000000000040';
  const body =
    state === 'image-preview-unavailable'
      ? parseDocument({
          ...text,
          profile: 'blocks',
          doc: {
            type: 'doc',
            content: [
              ...text.doc.content!,
              { type: 'image', attrs: { id: 'illustration', src: imageId, alt: imageAlt } },
            ],
          },
        })
      : text;
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
    mediaIds: state === 'image-preview-unavailable' ? [imageId] : [],
    licence: 'CC-BY-SA-4.0',
    subjectIds: [subjectId],
    voteCitation: null,
    body,
  };
  let edition: EditionMetadata | null = null;
  let subjectIdentity: EditionSubjectIdentity = {
    id: subjectId,
    kind: 'available',
    label: { value: '夜の航路', language: 'ja' },
  };
  let metadataUnavailable = false;
  let failNextMetadata = false;
  const editionIdentity = () => ({ subject: subjectIdentity, revisionCreatedAt: '2026-10-31T12:00:00.000Z' });
  let lost = state === 'uncertain';
  let conflict = state === 'conflict' || state === 'resumed-conflict';
  let lostPublish = state === 'uncertain-publish';
  const publishReceipts = new Map<string, { editionId: string; editionRevision: string }>();
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
      if (path === `/v1/posts/${postId}/revisions/${revisionId}`)
        return Response.json({
          post: revision,
          ...(new URL(request.url).searchParams.get('editionIdentity') === 'true'
            ? {
                editionIdentity: {
                  postId,
                  revisionId,
                  sha256,
                  revisionCreatedAt: editionIdentity().revisionCreatedAt,
                  subjects: [subjectIdentity],
                },
              }
            : {}),
        });
      if (path === `/v1/accounts/${creatorId}/editions`)
        return Response.json({
          editions: edition
            ? [
                {
                  ...edition,
                  ...(request.headers.get('rezics-edition-identity') === 'true' ? { identity: editionIdentity() } : {}),
                },
              ]
            : [],
          next: null,
        });
      if (path === '/v1/viewerActions') {
        const resource = JSON.parse(call.body!).resources[0];
        return Response.json({
          resources: [
            {
              ...resource,
              viewerActions: [
                {
                  action: resource.type === 'content.post' ? 'post:revise' : 'edition:sell',
                  operations: [resource.type === 'content.post' ? 'content_edition.create' : 'content_edition.publish'],
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
        const key = request.headers.get('idempotency-key')!;
        if (publishReceipts.has(key)) return Response.json(publishReceipts.get(key));
        if (conflict) {
          conflict = false;
          edition = { ...edition, editionRevision: '2' };
        }
        if (request.headers.get('if-match') !== `"${edition.editionRevision}"`)
          return Response.json({ code: 'precondition_failed' }, { status: 412 });
        edition = { ...edition, state: 'published', editionRevision: String(Number(edition.editionRevision) + 1) };
        publishReceipts.set(key, { editionId, editionRevision: edition.editionRevision });
        if (lostPublish) {
          lostPublish = false;
          throw new Error('Constructed lost publication response');
        }
        if (failNextMetadata) {
          metadataUnavailable = true;
          failNextMetadata = false;
        }
        return Response.json(publishReceipts.get(key));
      }
      if (path === `/v1/contentEditions/${editionId}` && edition)
        return metadataUnavailable
          ? Response.json({ code: 'overloaded' }, { status: 503 })
          : Response.json({
              ...edition,
              ...(request.headers.get('rezics-edition-identity') === 'true' ? { identity: editionIdentity() } : {}),
            });
      throw new Error(`Unexpected publication fixture request: ${request.method} ${path}`);
    },
    { preconnect() {} },
  );
  const api = createNativeEditionCreateApi('https://kernel.example', 'Bearer story-creator', creatorId, fetcher);
  let controller = new EditionPublicationController(api);
  await controller.select(identity);
  if (state !== 'selection' && state !== 'image-preview-unavailable') {
    controller.chooseSubject(subjectId);
    await controller.create();
    if (state === 'published' || state === 'refused' || state === 'conflict' || state === 'reloaded-published')
      await controller.publish();
  }
  const resumed = ['resumed-draft', 'reloaded-published', 'resumed-conflict', 'uncertain-publish'].includes(state);
  if (resumed) {
    // The returning controller reads the existing wire resource; it never creates a source or injects draft state.
    controller = new EditionPublicationController(api);
    await controller.resume(editionId);
    if (state === 'resumed-conflict' || state === 'uncertain-publish') await controller.publish();
  }
  return {
    api,
    controller,
    calls,
    resumed,
    fetcher,
    withholdIdentity() {
      subjectIdentity = { id: subjectId, kind: 'withheld', label: null };
    },
    restoreIdentity() {
      subjectIdentity = { id: subjectId, kind: 'available', label: { value: '夜の航路', language: 'ja' } };
    },
    staleVersion() {
      if (edition) edition = { ...edition, editionRevision: String(Number(edition.editionRevision) + 1) };
    },
    failPublicationRead() {
      failNextMetadata = true;
    },
    restoreRead() {
      metadataUnavailable = false;
    },
  };
}

function PublicationRouteExample({ fixture }: { fixture: Awaited<ReturnType<typeof publicationFixture>> }) {
  const search = fixture.resumed ? { editionId } : identity;
  const url = localizeUrl(new URL(`/editions/new?${new URLSearchParams(search)}`, 'https://site.example'));
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
      validateSearch: editionCreateSearch,
      loader: () => undefined,
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
