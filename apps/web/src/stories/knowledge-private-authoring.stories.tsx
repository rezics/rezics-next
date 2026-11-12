import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
import {
  KnowledgePrivateAccessEntry,
  type KnowledgePrivateOperations,
  type KnowledgePrivatePageAccess,
} from '../knowledge/private-page';
import type { KnowledgePrivateHead } from '../knowledge/private-knowledge';
import type { KnowledgeOutlinePage, KnowledgeOwnedNotebook } from '../knowledge/navigation.ts';
import {
  knowledgeBody,
  knowledgeDocumentId,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeViewports,
} from './knowledge-document-fixtures';
import { m } from '../paraglide/messages.js';
import { locales, setLocale, type Locale } from '../paraglide/runtime.js';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const notebookSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000044';
const parentPlacementId = '0192f3a0-6c1e-7b2a-9d4e-000000000015';
const placementId = '0192f3a0-6c1e-7b2a-9d4e-000000000014';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const nextStructureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000016';
const credential = 'illustrative-encrypted-visit-credential';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const session: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken: 'illustrative-authoring-session',
  owner: 'story-authoring-visit',
  read: 'available',
  createNotebook: 'available',
  listNotebooks: 'available',
  readOutline: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'denied',
};
const ownedNotebook: KnowledgeOwnedNotebook = {
  notebookId,
  subjectId: notebookSubjectId,
  title: 'Owned field notebook',
  structureRevisionId,
  createdAt: '2026-11-13T12:00:00.000Z',
};
let createAttempt = 0;
let uncertainReplay: Parameters<KnowledgePrivateOperations['createDocument']>[0] | undefined;
let uncertainReplayMatches = false;

function rootOutline(structure = structureRevisionId): KnowledgeOutlinePage {
  return {
    notebookId,
    structureRevisionId: structure,
    parentPlacementId: null,
    placements: [
      {
        placementId: parentPlacementId,
        documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000021',
        parentPlacementId: null,
        position: '0',
        title: 'Character arc',
      },
    ],
    next: null,
  };
}

function nestedOutline(): KnowledgeOutlinePage {
  return {
    notebookId,
    structureRevisionId,
    parentPlacementId,
    placements: [],
    next: null,
  };
}

function savedHead(title: string): KnowledgePrivateHead {
  return {
    accountId: viewer,
    notebookId,
    documentId: knowledgeDocumentId,
    revisionId: knowledgeRevisionId,
    publicationId: null,
    title,
    language: 'en',
    licence: 'LicenseRef-rezics-terms',
    subjectIds: [notebookSubjectId],
    body: knowledgeBody(title),
  };
}

function receipt() {
  return {
    state: 'acknowledged' as const,
    receipt: {
      notebookId,
      documentId: knowledgeDocumentId,
      placementId,
      revisionId: knowledgeRevisionId,
      structureRevisionId: nextStructureRevisionId,
    },
  };
}

function scenarioOperations(scenario: string): KnowledgePrivateOperations {
  let outlineReads = 0;
  return {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken: session.csrfToken, credential }),
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken: session.csrfToken,
      credential,
      head: savedHead(scenario === 'nested' ? 'Saved scene' : 'Saved inspiration'),
    }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'ready', page: { notebooks: [ownedNotebook], next: null } }),
    readOutline: async (input) => {
      outlineReads += 1;
      if (input.parentPlacementId === parentPlacementId) return { state: 'ready', page: nestedOutline() };
      return {
        state: 'ready',
        page: rootOutline(scenario === 'conflict' && outlineReads > 1 ? nextStructureRevisionId : structureRevisionId),
      };
    },
    createDocument: async (intent) => {
      if (scenario === 'conflict') {
        if (createAttempt++ === 0) return { state: 'conflict', status: 412 };
        return receipt();
      }
      if (scenario === 'uncertain') {
        if (createAttempt++ === 0) {
          uncertainReplay = structuredClone(intent);
          return { state: 'uncertain' };
        }
        uncertainReplayMatches = JSON.stringify(uncertainReplay) === JSON.stringify(intent);
        return receipt();
      }
      return receipt();
    },
    revise: async () => ({ state: 'unavailable', status: 503 }),
  };
}

function KnowledgePrivateAuthoringExample({ scenario, locale = 'en' }: { scenario: string; locale?: Locale }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  const operations = useMemo(() => scenarioOperations(scenario), [scenario]);
  const router = useMemo(() => {
    function Visit() {
      return (
        <KnowledgePrivateAccessEntry
          address={{ kind: 'create', subjectId: knowledgeSubjectId }}
          access={session}
          locale={locale}
          operations={operations}
        />
      );
    }
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: '/visit', component: Visit });
    return createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/visit'] }),
    });
  }, [locale, operations]);
  useEffect(() => {
    void setLocale(locale, { reload: false });
  }, [locale]);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Knowledge/PrivateAuthoring',
  id: 'pages-knowledge-private-authoring',
  component: KnowledgePrivateAuthoringExample,
  args: { scenario: 'existing', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { options: locales, control: 'select' } },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative signed-in existing-notebook authoring. Review ExistingNotebook, NestedParent, StructureChanged and Uncertain with phone390 and desktop1280, all eight locale globals and light/dark themes. These stories do not prove native authorization, browser geometry or integrated acceptance.',
      },
    },
  },
  beforeEach: () => {
    createAttempt = 0;
    uncertainReplay = undefined;
    uncertainReplayMatches = false;
  },
} satisfies Meta<typeof KnowledgePrivateAuthoringExample>;
export default meta;
type Story = StoryObj<typeof meta>;

async function tabTo(element: HTMLElement) {
  for (let step = 0; step < 40 && document.activeElement !== element; step++) await userEvent.tab();
  await expect(element).toHaveFocus();
}

function targetSize(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(getComputedStyle(element).whiteSpace).toBe('normal');
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}

async function chooseExisting(canvas: ReturnType<typeof within>) {
  await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_existing_notebook() }));
  const openNotebooks = await canvas.findByRole('button', { name: m.knowledge_private_open_notebooks() });
  targetSize(openNotebooks);
  await tabTo(openNotebooks);
  await userEvent.click(openNotebooks);
  await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_select_notebook() }));
  const openOutline = await canvas.findByRole('button', { name: m.knowledge_private_open_outline() });
  targetSize(openOutline);
  await userEvent.click(openOutline);
}

export const ExistingNotebook: Story = {
  name: 'Existing notebook root (illustrative)',
  args: { scenario: 'existing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseExisting(canvas);
    const place = await canvas.findByRole('button', { name: m.knowledge_private_place_here() });
    targetSize(place);
    await userEvent.click(place);
    await expect(canvas.getByText(m.knowledge_private_destination_root())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_template_inspiration() }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Saved inspiration' })).toBeVisible();
  },
};

export const NestedParent: Story = {
  name: 'Nested parent placement (illustrative)',
  args: { scenario: 'nested' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseExisting(canvas);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_open_parent() }));
    await expect(await canvas.findByText('Character arc')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_place_here() }));
    await expect(canvas.getByText(m.knowledge_private_review_destination())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_template_scene() }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Saved scene' })).toBeVisible();
  },
};

export const StructureChanged: Story = {
  name: 'Structure conflict rereads destination (illustrative)',
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseExisting(canvas);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_place_here() }));
    const title = await canvas.findByLabelText(m.knowledge_private_document_title());
    await userEvent.clear(title);
    await userEvent.type(title, 'Retained after conflict');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_conflict());
    await expect(canvas.getByText(m.knowledge_private_structure_changed())).toBeVisible();
    await expect(title).toHaveValue('Retained after conflict');
    await waitFor(() => expect(canvas.getByRole('button', { name: m.knowledge_private_place_here() })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_place_here() }));
    await expect(canvas.getByText(nextStructureRevisionId)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Saved inspiration' })).toBeVisible();
  },
};

export const Uncertain: Story = {
  name: 'Uncertain exact creation replay (illustrative)',
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseExisting(canvas);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_place_here() }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_uncertain());
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_retry_exact() }));
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Saved inspiration' })).toBeVisible();
    expect(uncertainReplayMatches).toBe(true);
    expect(uncertainReplay?.parentPlacementId).toBeNull();
    expect(uncertainReplay?.subjectId).toBe(notebookSubjectId);
  },
};
