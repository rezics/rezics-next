import { useEffect, useMemo, useRef, useState } from 'react';
import { fromPlainText } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { EditionApi, EditionMetadata, EditionRevision } from '../../../content-editions/edition-api';
import {
  editionDocumentDigest,
  loadContentEdition,
  type ContentEditionState,
} from '../../../content-editions/edition-model';
import { ContentEditionPage } from '../../../content-editions/edition-view';
import type { DocumentImagePresentation } from '../../../content-editions/edition-media';
import { AppShell } from '../../../shell/shell';
import { EditionRoute } from '../../../content-editions/edition-route';
import { deLocalizeUrl, localizeUrl } from '../../../paraglide/runtime.js';
import { setStoryRequestContext } from '../../../../.storybook/react-start';

export const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
export const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
export const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const editionText =
  'The quiet ending leaves room for the reader to pause. A fixed edition preserves the words as they were published.';
export const editionImageAlt = 'Three connected panels lead from a draft to the highlighted fixed edition.';
export const editionImage: DocumentImagePresentation = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000070',
  containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000071',
  digest: '723ef41a1bb70dc6b4fc06c67b20ecc48dc996c5ab5773f98735f57e725efdc6',
  width: 640,
  height: 320,
  variants: [
    { format: 'webp', width: 320, height: 160 },
    { format: 'webp', width: 640, height: 320 },
  ],
  placeholder: null,
  focalPoint: null,
  credit: null,
};
export type EditionExampleState =
  | 'published'
  | 'published-images'
  | 'missing-image'
  | 'longtext'
  | 'loading'
  | 'unavailable'
  | 'refused'
  | 'withdrawn'
  | 'version-mismatch';

/** Constructed exact native responses, never a recording or proof of buyer delivery. */
export async function editionFixture(state: EditionExampleState = 'published') {
  const text = fromPlainText(
    state === 'longtext'
      ? Array.from({ length: 32 }, (_, index) => `${index + 1}. ${editionText}`).join('\n\n')
      : editionText,
    'blocks',
  );
  const body =
    state === 'published-images' || state === 'missing-image'
      ? {
          ...text,
          doc: {
            ...text.doc,
            content: [
              ...text.doc.content!,
              { type: 'image', attrs: { id: 'edition-illustration', src: editionImage.id, alt: editionImageAlt } },
            ],
          },
        }
      : text;
  const metadata: EditionMetadata = {
    editionId,
    editionRevision: '1',
    state: state === 'withdrawn' ? 'withdrawn' : 'published',
    targetSubjectId: subjectId,
    creatorAccountId: creatorId,
    revisionId,
    sha256: await editionDocumentDigest(body),
    licence: 'CC-BY-SA-4.0',
  };
  const revision: EditionRevision = {
    editionId,
    revisionId: state === 'version-mismatch' ? creatorId : revisionId,
    sha256: metadata.sha256,
    licence: metadata.licence,
    body,
  };
  const calls: string[] = [];
  const read = async (path: string, authorization: string) => {
    if (authorization !== 'Bearer story-buyer') throw new Error('Example requires its explicit buyer fixture');
    calls.push(path);
    if (state === 'unavailable') return { state: 'unavailable', status: 503, reason: 'dependency' } as const;
    if (state === 'refused') return { state: 'refused', status: 403 } as const;
    if (path === `/v1/contentEditions/${editionId}`) return { state: 'available', value: metadata } as const;
    if (path === `/v1/contentEditions/${editionId}/revision`) return { state: 'available', value: revision } as const;
    throw new Error(`Unexpected edition example read: ${path}`);
  };
  const api: EditionApi = {
    async readMetadata(id, authorization) {
      const result = await read(`/v1/contentEditions/${id}`, authorization);
      if (result.state !== 'available') return result;
      // Each fixture endpoint returns only its assigned closed representation.
      if (!('editionRevision' in result.value)) throw new Error('Wrong fixture endpoint');
      return { state: 'available', value: result.value };
    },
    async readRevision(id, authorization) {
      const result = await read(`/v1/contentEditions/${id}/revision`, authorization);
      if (result.state !== 'available') return result;
      if (!('body' in result.value)) throw new Error('Wrong fixture endpoint');
      return { state: 'available', value: result.value };
    },
  };
  return { api, metadata, revision, calls };
}

async function readExample(state: EditionExampleState): Promise<ContentEditionState> {
  if (state === 'loading') return { state: 'loading' };
  const { api } = await editionFixture(state);
  return loadContentEdition(api, editionId, 'Bearer story-buyer', {
    subject: async (id) => ({ id, label: 'Reading the quiet ending' }),
    creator: async (id) => ({ id, name: 'Mina Chen' }),
    // Constructed independent media responses; omission makes no claim about why an image is unavailable.
    media: async () => ({
      kind: 'ready',
      images: new Map(state === 'published-images' ? [[editionImage.id, editionImage]] : []),
    }),
  });
}

function PatternExample({ state, recoverOnRetry }: { state: EditionExampleState; recoverOnRetry: boolean }) {
  const [page, setPage] = useState<ContentEditionState>({ state: 'loading' });
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);
  async function read(next: EditionExampleState, initial = false) {
    const request = ++generation.current;
    if (initial) setPage({ state: 'loading' });
    setRetrying(!initial);
    const fresh = await readExample(next);
    if (request === generation.current) {
      setPage(fresh);
      setRetrying(false);
    }
  }
  useEffect(() => {
    void read(state, true);
    return () => {
      generation.current += 1;
    };
  }, [state]);
  const view = (
    <ContentEditionPage
      editionId={editionId}
      page={page}
      retrying={retrying}
      onRetry={() => {
        void read(recoverOnRetry ? 'published' : state);
      }}
    />
  );
  return <div className="p-4 sm:p-8">{view}</div>;
}

/** The actual served route component runs against an isolated fixture loader, with the real shell and retry. */
function RouteExample({ state, recoverOnRetry }: { state: EditionExampleState; recoverOnRetry: boolean }) {
  const url = localizeUrl(new URL(`/editions/${editionId}`, 'https://site.example'));
  const entry = url.pathname;
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
    let reads = 0;
    const edition = createRoute({
      getParentRoute: () => root,
      path: '/editions/$id',
      staleTime: 0,
      gcTime: 0,
      pendingMs: 0,
      loader: () => readExample(reads++ > 0 && recoverOnRetry ? 'published' : state),
      component: EditionRoute,
    });
    const router = createRouter({
      routeTree: root.addChildren([edition]),
      history: createMemoryHistory({ initialEntries: [entry] }),
      context: { queryClient, credentialMode: 'session' },
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    return { router, queryClient };
  }, [entry, state, recoverOnRetry]);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

export function ContentEditionExample({
  state = 'published',
  shell = false,
  recoverOnRetry = false,
}: {
  state?: EditionExampleState;
  shell?: boolean;
  /** Only the explicitly constructed recovery transition changes its source response after retry. */
  recoverOnRetry?: boolean;
}) {
  return shell ? (
    <RouteExample state={state} recoverOnRetry={recoverOnRetry} />
  ) : (
    <PatternExample state={state} recoverOnRetry={recoverOnRetry} />
  );
}

export const editionViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
