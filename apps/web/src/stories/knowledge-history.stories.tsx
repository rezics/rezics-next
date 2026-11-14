import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
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
import { serializeDocument } from '@rezics/document';
import {
  KnowledgePrivateAccessEntry,
  type KnowledgePrivateOperations,
  type KnowledgePrivatePageAccess,
} from '../knowledge/private-page';
import type { KnowledgePrivateHead } from '../knowledge/private-knowledge';
import type { KnowledgeHistoryRevision } from '../knowledge/history';
import {
  knowledgeBody,
  knowledgeDocumentId as documentId,
  knowledgeRevisionId as revisionA,
  knowledgeOtherRevisionId as revisionB,
  knowledgeSubjectId,
  knowledgeViewports,
} from './knowledge-document-fixtures';
import { m } from '../paraglide/messages.js';
import { locales, setLocale, type Locale } from '../paraglide/runtime.js';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const csrfToken = 'illustrative-history-session';
const credential = 'illustrative-history-credential';
const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'illustrative-history-visit',
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
type Scenario =
  | 'Revisions'
  | 'Comparison'
  | 'ConflictedDraft'
  | 'Sparse'
  | 'Unavailable'
  | 'CrossPageComparison'
  | 'FailedExactRetry'
  | 'WindowEdge'
  | 'DeliberateFocus';
const olderCursor = 'illustrative +/= exact older request';
function illustrativeOperations(scenario: Scenario): KnowledgePrivateOperations {
  const original: KnowledgePrivateHead = {
    accountId: viewer,
    notebookId,
    documentId,
    revisionId: revisionA,
    publicationId: null,
    title: 'The promise at the end of the scene',
    language: 'en',
    licence: 'CC-BY-SA-4.0',
    subjectIds: [knowledgeSubjectId],
    body: knowledgeBody(
      'The character avoids the question at first.\nA promise changes the decision.\nThe scene ends before we know the cost.',
    ),
  };
  const revisedBody = structuredClone(original.body);
  revisedBody.doc.content![1]!.content = [
    { type: 'text', text: 'A promise changes what the character is willing to risk.' },
  ];
  const current: KnowledgePrivateHead = {
    ...original,
    revisionId: revisionB,
    title: 'The promise and its cost',
    body: revisedBody,
  };
  const saved = (id: string): KnowledgeHistoryRevision => {
    const head = id === revisionA ? original : { ...current, revisionId: id };
    return {
      ...head,
      sha256: id === revisionA ? 'a'.repeat(64) : 'b'.repeat(64),
      source: serializeDocument(head.body),
      provenance: null,
      references: [{ id: 'character', role: 'about', target: { kind: 'subject', subjectId: knowledgeSubjectId } }],
    };
  };
  let reads = 0;
  let failedOlderRead = false;
  return {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: scenario === 'ConflictedDraft' && reads++ > 0 ? current : original,
    }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'conflict', status: 412 }),
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    history: {
      read: async (_address, cursor) => {
        if (scenario === 'DeliberateFocus') await new Promise((resolve) => setTimeout(resolve, 180));
        if (scenario === 'Unavailable') return { state: 'unavailable', status: 503 };
        if (scenario === 'FailedExactRetry' && cursor === olderCursor && !failedOlderRead) {
          failedOlderRead = true;
          return { state: 'unavailable', status: 503 };
        }
        let heads = [current, original];
        let next: string | null = null;
        if (scenario === 'Sparse' && cursor === null) {
          heads = [];
          next = olderCursor;
        }
        if (scenario === 'CrossPageComparison' || scenario === 'FailedExactRetry') {
          heads = cursor === null ? [current] : [original];
          next = cursor === null ? olderCursor : null;
        }
        if (scenario === 'WindowEdge') {
          const index = cursor === null ? 0 : Number(cursor.slice('window:'.length));
          heads = [
            {
              ...current,
              revisionId: `0192f3a0-6c1e-7b2a-9d4e-${(40 + index).toString(16).padStart(12, '0')}`,
              title: `Saved page ${index}`,
            },
          ];
          next = `window:${index + 1}`;
        }
        return {
          state: 'ready',
          page: {
            documentId,
            revisions: heads.map((head) => ({
              revisionId: head.revisionId,
              title: head.title,
              language: head.language,
              licence: head.licence,
              sha256: saved(head.revisionId).sha256,
              createdAt: head.revisionId === revisionA ? '2026-11-01T09:00:00.000Z' : '2026-11-02T12:30:00.000Z',
            })),
            next,
          },
        };
      },
      compare: async (_address, pair) => ({
        state: 'ready',
        comparison: { documentId, left: saved(pair.leftRevisionId), right: saved(pair.rightRevisionId) },
      }),
    },
  };
}
function HistoryExample({ scenario, locale }: { scenario: Scenario; locale: Locale }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  const operations = useMemo(() => illustrativeOperations(scenario), [scenario]);
  const router = useMemo(() => {
    function Visit() {
      return (
        <KnowledgePrivateAccessEntry
          address={{ kind: 'resume', notebookId, documentId }}
          access={access}
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
  }, [operations, locale]);
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
  title: 'Pages/Knowledge/History',
  component: HistoryExample,
  args: { scenario: 'Revisions', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { options: locales, control: 'select' } },
  globals: { visitor: 'Signed In' },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative private history for a signed-in author. Use phone390 and desktop1280, both themes and all eight locales. Previous/next, sparse continuation, exact retry, cross-page comparison return, the bounded edge and deliberate keyboard focus are source fixtures. Native two-editor/history, accessibility, visual review and promotion remain integration verifier acceptance.',
      },
    },
  },
} satisfies Meta<typeof HistoryExample>;
export default meta;
type Story = StoryObj<typeof meta>;
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_history_open() }));
  return canvas;
}
export const Revisions: Story = {
  args: { scenario: 'Revisions' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` }),
    ).toBeVisible();
  },
};
export const Comparison: Story = {
  args: { scenario: 'Comparison' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` }));
    await userEvent.click(canvas.getByRole('radio', { name: `${m.knowledge_history_right()}: ${revisionB}` }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_compare() }));
    await expect(await canvas.findByText(m.knowledge_history_difference_help())).toBeVisible();
  },
};
export const ConflictedDraft: Story = {
  args: { scenario: 'ConflictedDraft' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByLabelText(m.knowledge_private_document_title(), { selector: 'input' });
    await userEvent.clear(title);
    await userEvent.type(title, 'My retained interpretation of the scene');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_save() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_reread() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_history_compare_heads() }));
    await expect(await canvas.findByText(m.knowledge_history_local_draft())).toBeVisible();
    await expect(title).toHaveValue('My retained interpretation of the scene');
  },
};
export const Sparse: Story = {
  args: { scenario: 'Sparse' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.knowledge_history_sparse())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_history_more() })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_more() }));
    await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` });
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_previous() }));
    await expect(await canvas.findByText(m.knowledge_history_sparse())).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'Unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.knowledge_history_unavailable())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_private_retry() })).toBeEnabled();
  },
};

export const CrossPageComparisonReturn: Story = {
  args: { scenario: 'CrossPageComparison' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByLabelText(m.knowledge_private_document_title(), { selector: 'input' });
    await userEvent.clear(title);
    await userEvent.type(title, 'My retained cross-page draft');
    await open(canvasElement);
    await userEvent.click(await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionB}` }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_more() }));
    await userEvent.click(await canvas.findByRole('radio', { name: `${m.knowledge_history_right()}: ${revisionA}` }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_compare() }));
    await expect(await canvas.findByText(m.knowledge_history_difference_help())).toBeVisible();
    canvas.getByRole('button', { name: m.knowledge_history_back() }).focus();
    await userEvent.keyboard('[Enter]');
    await expect(canvas.getByRole('button', { name: m.knowledge_history_compare() })).toHaveFocus();
    await expect(canvas.getByRole('radio', { name: `${m.knowledge_history_right()}: ${revisionA}` })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_previous() }));
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionB}` }),
    ).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_more() }));
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_right()}: ${revisionA}` }),
    ).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_return() }));
    await expect(title).toHaveValue('My retained cross-page draft');
  },
};
export const FailedExactRetry: Story = {
  args: { scenario: 'FailedExactRetry' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionB}` });
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_more() }));
    await expect(await canvas.findByText(m.knowledge_history_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_retry() }));
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_previous() }));
    await expect(
      await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionB}` }),
    ).toBeVisible();
  },
};
export const WindowEdge: Story = {
  args: { scenario: 'WindowEdge' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByRole('heading', { name: 'Saved page 0' });
    for (let index = 1; index <= 22; index++) {
      await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_more() }));
      await canvas.findByRole('heading', { name: `Saved page ${index}` });
    }
    for (let index = 21; index >= 4; index--) {
      await userEvent.click(canvas.getByRole('button', { name: m.knowledge_history_previous() }));
      await canvas.findByRole('heading', { name: `Saved page ${index}` });
    }
    await expect(canvas.getByRole('button', { name: m.knowledge_history_previous() })).toBeDisabled();
    await expect(canvas.getByText(m.knowledge_history_window_edge())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_history_restart() })).toBeEnabled();
  },
};
export const DeliberateFocus: Story = {
  args: { scenario: 'DeliberateFocus' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` });
    await expect(canvas.getByRole('heading', { name: m.knowledge_history_heading(), level: 2 })).not.toHaveFocus();
    canvas.getByRole('button', { name: m.knowledge_history_return() }).focus();
    await userEvent.keyboard('[Enter]');
    await expect(canvas.getByRole('button', { name: m.knowledge_history_open() })).toHaveFocus();
    await userEvent.keyboard('[Enter]');
    await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` });
    await expect(canvas.getByRole('heading', { name: m.knowledge_history_heading(), level: 2 })).toHaveFocus();
    canvas.getByRole('button', { name: m.knowledge_history_restart() }).focus();
    await userEvent.keyboard('[Enter]');
    const title = canvas.getByLabelText(m.knowledge_private_document_title(), { selector: 'input' });
    await userEvent.click(title);
    await canvas.findByRole('radio', { name: `${m.knowledge_history_left()}: ${revisionA}` });
    await expect(title).toHaveFocus();
  },
};
