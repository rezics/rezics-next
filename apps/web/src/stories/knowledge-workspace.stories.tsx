import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { serializeDocument } from '@rezics/document';
import {
  KnowledgePrivateAccessEntry,
  type KnowledgePrivateOperations,
  type KnowledgePrivatePageAccess,
} from '../knowledge/private-page';
import { KnowledgeNavigationEntry, type KnowledgeNavigationOperations } from '../knowledge/navigation-page';
import { KnowledgeDocumentCaller, type KnowledgeDocumentVisit } from '../knowledge/route';
import type { KnowledgePrivateHead } from '../knowledge/private-knowledge';
import type { KnowledgeHistoryRevision } from '../knowledge/history';
import { readerSessionSource } from '../reader/lifetime';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/app-shell';
import { locales, setLocale, type Locale } from '../paraglide/runtime.js';
import {
  knowledgeLongStudyBody,
  knowledgeAdmitted,
  knowledgeBody,
  knowledgeDocumentId,
  knowledgeOtherRevisionId,
  knowledgePublicationId,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeViewports,
} from './knowledge-document-fixtures';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const csrfToken = 'illustrative-workspace-session';
const credential = 'illustrative-workspace-credential';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000030';
const secondDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000031';
const longDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000032';
const notebookTitle = 'The lighthouse: a character notebook';
const documentTitle = 'The promise and its cost';
const longTitle = 'Scene study: leaving the lighthouse';

const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'illustrative-workspace',
  read: 'available',
  createNotebook: 'available',
  listNotebooks: 'available',
  readOutline: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'available',
  history: 'available',
  compare: 'available',
};
type Scenario = 'notebook' | 'writing' | 'long' | 'reading' | 'recovery' | 'branches';

/** Contract-shaped examples for interface review; these callbacks are not a native publisher or proof. */
function exampleSources(scenario: Scenario) {
  const base: KnowledgePrivateHead = {
    accountId: viewer,
    notebookId,
    documentId: knowledgeDocumentId,
    revisionId: knowledgeOtherRevisionId,
    publicationId: scenario === 'reading' ? knowledgePublicationId : null,
    title: documentTitle,
    language: 'en',
    licence: 'CC-BY-SA-4.0',
    subjectIds: [knowledgeSubjectId],
    references: [],
    body: knowledgeBody(
      'A promise changes what Mara is willing to risk. The decision remains hers, even when the ferry horn makes the cost of waiting audible.\nThe private scene notes remain independent of this selected analysis.',
    ),
  };
  const previous: KnowledgePrivateHead = {
    ...base,
    revisionId: knowledgeRevisionId,
    title: 'A promise at the lighthouse',
    body: knowledgeBody(
      'Mara leaves because the ferry is about to depart. The first draft treats the decision as inevitable.',
    ),
  };
  const heads = new Map([
    [knowledgeDocumentId, base],
    [
      secondDocumentId,
      {
        ...base,
        documentId: secondDocumentId,
        title: 'Inspiration: the offered cup',
        body: knowledgeBody(
          'Keep the second cup visible before the argument begins. An ordinary gesture can hold a relationship without explaining it.\nReference question: where else does an offered object become a promise?',
        ),
      },
    ],
    [longDocumentId, { ...base, documentId: longDocumentId, title: longTitle, body: knowledgeLongStudyBody }],
  ]);
  const saved = new Map([
    [knowledgeRevisionId, previous],
    [knowledgeOtherRevisionId, base],
  ]);
  const publicSelections = new Map(scenario === 'reading' ? [[base.revisionId, base]] : []);
  let failedOutline = false;
  let failedHistory = false;
  let failedBranch = false;
  const historyRevision = (revisionId: string): KnowledgeHistoryRevision => {
    const head = saved.get(revisionId)!;
    return {
      ...head,
      source: serializeDocument(head.body),
      sha256: revisionId === knowledgeRevisionId ? 'a'.repeat(64) : 'b'.repeat(64),
      references: [],
      provenance: null,
    };
  };
  const operations: KnowledgePrivateOperations = {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async (address) => ({ state: 'ready', viewer, csrfToken, credential, head: heads.get(address.documentId)! }),
    listNotebooks: async () => ({
      state: 'ready',
      page: {
        notebooks: [
          {
            notebookId,
            subjectId: knowledgeSubjectId,
            title: notebookTitle,
            structureRevisionId,
            createdAt: '2026-11-01T09:00:00Z',
          },
        ],
        next: null,
      },
    }),
    readOutline: async (request) => {
      if (scenario === 'recovery' && !failedOutline) {
        failedOutline = true;
        return { state: 'unavailable', status: 503 };
      }
      if (scenario === 'branches' && request.cursor && !failedBranch) {
        failedBranch = true;
        return { state: 'unavailable', status: 503 };
      }
      return {
        state: 'ready',
        page: {
          notebookId,
          structureRevisionId,
          parentPlacementId: request.parentPlacementId,
          placements: request.parentPlacementId
            ? scenario === 'branches' && (request.cursor || request.parentPlacementId.endsWith('041'))
              ? [
                  {
                    placementId: request.parentPlacementId.endsWith('041')
                      ? '0192f3a0-6c1e-7b2a-9d4e-000000000061'
                      : '0192f3a0-6c1e-7b2a-9d4e-000000000060',
                    documentId: longDocumentId,
                    parentPlacementId: request.parentPlacementId,
                    position: '4',
                    title: request.parentPlacementId.endsWith('041')
                      ? 'The offered cup: scene connections'
                      : 'The promise: scene connections',
                  },
                ]
              : []
            : [...heads.values()].map((head, index) => ({
                placementId: `0192f3a0-6c1e-7b2a-9d4e-00000000004${index}`,
                documentId: head.documentId,
                parentPlacementId: null,
                position: String(index + 1),
                title: head.title,
              })),
          next:
            scenario === 'branches' && request.parentPlacementId?.endsWith('040') && !request.cursor
              ? 'illustrative-child-continuation'
              : null,
        },
      };
    },
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async (intent) => {
      const head = heads.get(intent.documentId)!;
      if (head.revisionId !== intent.expectedHeadRevisionId) return { state: 'conflict', status: 412 };
      const next = { ...head, ...intent, revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000050' };
      heads.set(intent.documentId, next);
      saved.set(next.revisionId, next);
      return { state: 'acknowledged', receipt: { documentId: next.documentId, revisionId: next.revisionId } };
    },
    selectPublication: async (intent) => {
      const head = heads.get(intent.documentId)!;
      if (head.revisionId !== intent.expectedHeadRevisionId || head.publicationId !== intent.expectedPublicationId)
        return { state: 'conflict', status: 412 };
      const publicationId = intent.revisionId === null ? null : knowledgePublicationId;
      heads.set(head.documentId, { ...head, publicationId });
      if (intent.revisionId) publicSelections.set(intent.revisionId, head);
      else publicSelections.clear();
      return {
        state: 'acknowledged',
        receipt: { documentId: head.documentId, revisionId: intent.revisionId, publicationId },
      };
    },
    history: {
      read: async () => {
        if (scenario === 'recovery' && !failedHistory) {
          failedHistory = true;
          return { state: 'unavailable' };
        }
        return {
          state: 'ready',
          page: {
            documentId: knowledgeDocumentId,
            next: null,
            revisions: [...saved.values()].map((head, index) => ({
              revisionId: head.revisionId,
              title: head.title,
              language: head.language,
              licence: head.licence,
              sha256: historyRevision(head.revisionId).sha256,
              createdAt: `2026-11-0${index + 1}T09:00:00Z`,
            })),
          },
        };
      },
      compare: async (_address, pair) => ({
        state: 'ready',
        comparison: {
          documentId: knowledgeDocumentId,
          left: historyRevision(pair.leftRevisionId),
          right: historyRevision(pair.rightRevisionId),
        },
      }),
    },
  };
  const navigation: KnowledgeNavigationOperations = {
    read: async (request) => {
      if (request.kind === 'owned') {
        const result = await operations.listNotebooks(null, { viewer, csrfToken });
        return result.state === 'ready'
          ? { state: 'ready', page: { kind: 'owned', ...result.page } }
          : { state: 'unavailable' };
      }
      const result = await operations.readOutline(
        { ...request, cursor: request.cursor ?? null },
        { viewer, csrfToken },
      );
      return result.state === 'ready'
        ? { state: 'ready', page: { kind: 'outline', ...result.page } }
        : { state: 'unavailable' };
    },
  };
  return { operations, navigation, publicSelections };
}

function WorkspaceExample({ scenario, locale }: { scenario: Scenario; locale: Locale }) {
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: viewer, csrfToken });
    return client;
  });
  const router = useMemo(() => {
    const sources = exampleSources(scenario);
    function Notebook() {
      return (
        <KnowledgeNavigationEntry
          address={{ kind: 'outline', notebookId, parentPlacementId: null }}
          access="available"
          locale={locale}
          binding="illustrative-workspace"
          operations={sources.navigation}
        />
      );
    }
    function Editor() {
      const params = useParams({ from: '/knowledge/notebooks/$notebookId/documents/$documentId' });
      return (
        <KnowledgePrivateAccessEntry
          address={{ kind: 'resume', notebookId: params.notebookId, documentId: params.documentId }}
          access={access}
          locale={locale}
          operations={sources.operations}
        />
      );
    }
    function Reader() {
      const params = useParams({ from: '/knowledge/documents/$id' });
      const search = useSearch({ from: '/knowledge/documents/$id' });
      const request = { documentId: params.id, revisionId: search.revisionId ?? null, locale };
      const open = (): KnowledgeDocumentVisit => {
        const selected = request.revisionId
          ? sources.publicSelections.get(request.revisionId)
          : [...sources.publicSelections.values()].at(-1);
        return {
          request,
          sessionRevision: readerSessionSource(client).snapshot(),
          page: selected
            ? {
                state: 'ready',
                document: knowledgeAdmitted({
                  documentId: selected.documentId,
                  revisionId: selected.revisionId,
                  title: selected.title,
                  body: selected.body,
                }),
              }
            : { state: 'not-found', status: 404 },
        };
      };
      const [visit, setVisit] = useState(open);
      return (
        <KnowledgeDocumentCaller visit={visit} request={request} loading={false} onRetry={() => setVisit(open())} />
      );
    }
    const root = createRootRoute({
      component: () => (
        <AppShell communities={null} notifications={null}>
          <Outlet />
        </AppShell>
      ),
    });
    const notebook = createRoute({
      getParentRoute: () => root,
      path: '/knowledge/notebooks/$notebookId',
      component: Notebook,
    });
    const editor = createRoute({
      getParentRoute: () => root,
      path: '/knowledge/notebooks/$notebookId/documents/$documentId',
      component: Editor,
    });
    const reader = createRoute({
      getParentRoute: () => root,
      path: '/knowledge/documents/$id',
      component: Reader,
      validateSearch: (search: Record<string, unknown>): { revisionId?: string } =>
        typeof search.revisionId === 'string' ? { revisionId: search.revisionId } : {},
    });
    const owned = createRoute({
      getParentRoute: () => root,
      path: '/knowledge',
      component: () => (
        <KnowledgeNavigationEntry
          address={{ kind: 'owned' }}
          access="available"
          locale={locale}
          binding="illustrative-workspace"
          operations={sources.navigation}
        />
      ),
    });
    const initial =
      scenario === 'notebook'
        ? `/knowledge/notebooks/${notebookId}`
        : scenario === 'reading'
          ? `/knowledge/documents/${knowledgeDocumentId}?revisionId=${knowledgeOtherRevisionId}`
          : `/knowledge/notebooks/${notebookId}/documents/${scenario === 'long' ? longDocumentId : knowledgeDocumentId}`;
    return createRouter({
      routeTree: root.addChildren([owned, notebook, editor, reader]),
      history: createMemoryHistory({ initialEntries: [initial] }),
    });
  }, [client, scenario, locale]);
  useEffect(() => {
    setLocale(locale, { reload: false });
  }, [locale]);
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Pages/Knowledge/Workspace',
  id: 'pages-knowledge-workspace',
  component: WorkspaceExample,
  args: { scenario: 'writing', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { control: 'select', options: locales } },
  globals: { visitor: 'Signed In' },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Manual review through the installed notebook, editor and reader route shapes, using contract-shaped examples. Browse three documents, write, inspect revisions, review one saved publication and return from the public reader. Recovery in navigation and history is independent of the retained writing. Existing History and Publication stories retain comparison, uncertain replay and explicit confirmation examples. These examples are not native acceptance or a publisher.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Notebook: Story = { args: { scenario: 'notebook' } };
export const Writing: Story = { args: { scenario: 'writing' } };
export const LongDocument: Story = { args: { scenario: 'long' } };
export const PublicReading: Story = { args: { scenario: 'reading' } };
async function openWorkspaceOutline(canvasElement: HTMLElement, locale: Locale) {
  const view = within(canvasElement.ownerDocument.body);
  const options = { locale };
  // The installed shell supplies only the expanded rail or the open phone Menu host.
  if (!view.queryByRole('button', { name: m.knowledge_workspace_navigation_open({}, options) })) {
    const expand = view.queryByRole('button', { name: m.shell_expand_navigation({}, options) });
    await userEvent.click(expand ?? view.getByRole('button', { name: m.shell_open_navigation({}, options) }));
  }
  await userEvent.click(await view.findByRole('button', { name: m.knowledge_workspace_navigation_open({}, options) }));
  return view.getByRole('region', { name: m.knowledge_workspace_documents({}, options) });
}

export const NestedOutline: Story = {
  args: { scenario: 'branches' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale };
    const title = await canvas.findByLabelText(m.knowledge_private_document_title({}, options), { selector: 'input' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Keep this draft while browsing');
    const navigation = await openWorkspaceOutline(canvasElement, args.locale);
    const outline = within(navigation);
    await userEvent.click(
      await outline.findByRole('button', { name: `${m.knowledge_navigation_children({}, options)}: ${documentTitle}` }),
    );
    await userEvent.click(
      outline.getByRole('button', {
        name: `${m.knowledge_navigation_children({}, options)}: Inspiration: the offered cup`,
      }),
    );
    await expect(
      await outline.findByRole('link', {
        name: `${m.knowledge_navigation_open_document({}, options)}: The offered cup: scene connections`,
      }),
    ).toBeVisible();
    await userEvent.click(outline.getByRole('button', { name: m.knowledge_navigation_more({}, options) }));
    await userEvent.click(await outline.findByRole('button', { name: m.knowledge_navigation_retry({}, options) }));
    await expect(
      await outline.findByRole('link', {
        name: `${m.knowledge_navigation_open_document({}, options)}: The promise: scene connections`,
      }),
    ).toBeVisible();
    await userEvent.click(
      outline.getByRole('button', { name: `${m.knowledge_navigation_collapse({}, options)}: ${documentTitle}` }),
    );
    await userEvent.click(
      outline.getByRole('button', { name: `${m.knowledge_navigation_children({}, options)}: ${documentTitle}` }),
    );
    await expect(title).toHaveValue('Keep this draft while browsing');
    await expect(
      outline.getByRole('link', { name: `${m.knowledge_navigation_open_document({}, options)}: ${documentTitle}` }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(canvasElement.querySelector('[data-private-knowledge-visit] aside')).toBeNull();
    await expect(
      canvasElement.querySelector('[data-private-knowledge-visit] [data-shell-context-navigation]'),
    ).toBeNull();
  },
};

export const IndependentRecovery: Story = {
  args: { scenario: 'recovery' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    const title = await canvas.findByLabelText(m.knowledge_private_document_title({}, options), { selector: 'input' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Keep this local interpretation');
    const navigation = await openWorkspaceOutline(canvasElement, args.locale);
    await userEvent.click(
      await within(navigation).findByRole('button', { name: m.knowledge_navigation_retry({}, options) }),
    );
    await expect(
      await within(navigation).findByRole('link', {
        name: `${m.knowledge_navigation_open_document({}, options)}: Inspiration: the offered cup`,
      }),
    ).toBeVisible();
    await expect(title).toHaveValue('Keep this local interpretation');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_open({}, options) }));
    await expect(await canvas.findByText(m.knowledge_history_unavailable({}, options))).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_retry({}, options) }));
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_left({}, options)}: ${knowledgeRevisionId}` }),
    ).toBeVisible();
    await expect(title).toHaveValue('Keep this local interpretation');
  },
};
export const PublicationReturn: Story = {
  args: { scenario: 'writing' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_publication_review({}, options) }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_publication_confirm({}, options) }));
    const exact = await canvas.findByRole('link', { name: m.knowledge_publication_exact({}, options) });
    await expect(exact).toHaveAttribute(
      'href',
      `/${args.locale}/knowledge/documents/${knowledgeDocumentId}?revisionId=${knowledgeOtherRevisionId}`,
    );
    await userEvent.click(exact);
    await expect(await canvas.findByText(m.knowledge_exact_kind({}, options))).toBeVisible();
    await expect(canvas.queryByText(notebookId)).toBeNull();
    await expect(canvas.queryByText('Inspiration: the offered cup')).toBeNull();
    await userEvent.click(canvas.getByRole('link', { name: m.knowledge_workspace_return_editor({}, options) }));
    await expect(await canvas.findByRole('heading', { level: 1, name: documentTitle })).toBeVisible();
  },
};
