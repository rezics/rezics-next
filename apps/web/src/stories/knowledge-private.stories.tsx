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
const nextRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const credential = 'illustrative-encrypted-visit-credential';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const session: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken: 'illustrative-session-token',
  owner: 'story-visit',
  read: 'available',
  createNotebook: 'available',
  listNotebooks: 'available',
  readOutline: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'denied',
};
const head: KnowledgePrivateHead = {
  accountId: viewer,
  notebookId,
  documentId: knowledgeDocumentId,
  revisionId: knowledgeRevisionId,
  publicationId: null,
  title: 'A private field note',
  language: 'en',
  licence: 'LicenseRef-rezics-terms',
  subjectIds: [knowledgeSubjectId],
  body: knowledgeBody('A private note prepared for this Subject.'),
};
let uncertainReplay: Parameters<KnowledgePrivateOperations['revise']>[0] | undefined;
let uncertainReplayMatches = false;
let uncertainAttempt = 0;

function scenarioOperations(scenario: string): KnowledgePrivateOperations {
  return {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async (_subjectId) => ({ state: 'ready', viewer, csrfToken: session.csrfToken, credential }),
    read: async () =>
      scenario === 'retired'
        ? { state: 'retired' }
        : { state: 'ready', viewer, csrfToken: session.csrfToken, credential, head },
    createNotebook: async () => ({
      state: 'acknowledged',
      receipt: { notebookId, structureRevisionId: knowledgeRevisionId },
    }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () =>
      scenario === 'document-failure'
        ? { state: 'unavailable', status: 503 }
        : {
            state: 'acknowledged',
            receipt: {
              notebookId,
              documentId: knowledgeDocumentId,
              placementId: nextRevisionId,
              revisionId: knowledgeRevisionId,
              structureRevisionId: nextRevisionId,
            },
          },
    revise: async (intent) => {
      if (scenario === 'conflict') return { state: 'conflict', status: 412 };
      if (scenario === 'uncertain') {
        if (uncertainAttempt++ === 0) {
          uncertainReplay = structuredClone(intent);
          return { state: 'uncertain' };
        }
        uncertainReplayMatches = JSON.stringify(uncertainReplay) === JSON.stringify(intent);
        return {
          state: 'acknowledged',
          receipt: { documentId: knowledgeDocumentId, revisionId: nextRevisionId },
        };
      }
      return { state: 'acknowledged', receipt: { documentId: knowledgeDocumentId, revisionId: nextRevisionId } };
    },
  };
}

function KnowledgePrivateExample({ scenario, locale = 'en' }: { scenario: string; locale?: Locale }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  const operations = useMemo(() => scenarioOperations(scenario), [scenario]);
  const address = useMemo(
    () =>
      scenario === 'resume' || scenario === 'conflict' || scenario === 'uncertain' || scenario === 'retired'
        ? { kind: 'resume' as const, notebookId, documentId: knowledgeDocumentId }
        : { kind: 'create' as const, subjectId: knowledgeSubjectId },
    [scenario],
  );
  const access: KnowledgePrivatePageAccess = useMemo(
    () => (scenario === 'signed-out' ? { state: 'signed-out' } : session),
    [scenario],
  );
  const router = useMemo(() => {
    function Visit() {
      return <KnowledgePrivateAccessEntry address={address} access={access} locale={locale} operations={operations} />;
    }
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: '/visit', component: Visit });
    return createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/visit'] }),
    });
  }, [access, address, locale, operations]);
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
  title: 'Knowledge/Private document',
  id: 'pages-knowledge-private-document',
  component: KnowledgePrivateExample,
  args: { scenario: 'create', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { options: locales, control: 'select' } },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative local command outcomes only. Review signed-out, creation, acknowledged notebook/document failure, resumed editor, retained conflict draft, exact uncertain replay and access retirement with phone390 and desktop1280, all eight locale globals and light/dark themes. These stories do not prove native authorization, browser geometry or integrated acceptance.',
      },
    },
  },
  beforeEach: () => {
    uncertainAttempt = 0;
    uncertainReplay = undefined;
    uncertainReplayMatches = false;
  },
} satisfies Meta<typeof KnowledgePrivateExample>;
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

export const SignedOutEntry: Story = {
  name: 'Signed-out entry (illustrative)',
  args: { scenario: 'signed-out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_private_signed_out());
    const signIn = canvas.getByRole('link', { name: m.knowledge_private_sign_in() });
    await expect(signIn).toHaveAttribute(
      'href',
      '/auth/sign-in?return_to=%2Fknowledge%2Fnew%3FsubjectId%3D' + knowledgeSubjectId,
    );
    targetSize(signIn);
    await tabTo(signIn);
  },
};

export const Creation: Story = {
  name: 'Create notebook, review and create document (illustrative)',
  args: { scenario: 'create' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const notebookTitle = await canvas.findByLabelText(m.knowledge_private_notebook_title());
    targetSize(notebookTitle);
    await tabTo(notebookTitle);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_create_notebook() }));
    await expect(await canvas.findByText(m.knowledge_private_notebook_acknowledged())).toBeVisible();
    await expect(canvas.getByText(knowledgeSubjectId)).toBeVisible();
    const createDocument = canvas.getByRole('button', { name: m.knowledge_private_create_document() });
    targetSize(createDocument);
    await userEvent.click(createDocument);
    await expect(await canvas.findByRole('link', { name: m.knowledge_private_open_document() })).toHaveAttribute(
      'href',
      `/en/knowledge/notebooks/${notebookId}/documents/${knowledgeDocumentId}`,
    );
  },
};

export const NotebookAcknowledgedDocumentFailure: Story = {
  name: 'Notebook acknowledged; document failure (illustrative)',
  args: { scenario: 'document-failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_private_create_notebook() }));
    await expect(await canvas.findByText(m.knowledge_private_notebook_acknowledged())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_create_document() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_unavailable());
    await expect(canvas.getByText(notebookId)).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_private_retry_exact() })).toBeEnabled();
  },
};

export const ResumedEditor: Story = {
  name: 'Resume exact private head (illustrative)',
  args: { scenario: 'resume' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: head.title })).toBeVisible();
    await expect(canvas.getByText(knowledgeRevisionId)).toBeVisible();
    await expect(canvas.getByText('A private note prepared for this Subject.')).toBeVisible();
  },
};

export const ConflictRetainsDraft: Story = {
  name: 'Conflict retains draft for review (illustrative)',
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByLabelText(m.knowledge_private_document_title());
    await userEvent.clear(title);
    await userEvent.type(title, 'My retained draft');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_save() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_conflict());
    await expect(title).toHaveValue('My retained draft');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_reread() }));
    await expect(await canvas.findByRole('heading', { name: m.knowledge_private_review_current_head() })).toBeVisible();
    await expect(canvas.getByText('My retained draft')).toBeVisible();
  },
};

export const UncertainExactReplay: Story = {
  name: 'Uncertain exact revision replay (illustrative)',
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByLabelText(m.knowledge_private_document_title());
    await userEvent.clear(title);
    await userEvent.type(title, 'Replay this exact draft');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_save() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_uncertain());
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_retry_exact() }));
    await waitFor(() => expect(canvas.getByText(m.knowledge_private_saved_receipt())).toBeVisible());
    await expect(title).toHaveValue('Replay this exact draft');
    expect(uncertainReplay?.title).toBe('Replay this exact draft');
    expect(uncertainReplayMatches).toBe(true);
  },
};

export const AccessRetirement: Story = {
  name: 'Access retirement (illustrative)',
  args: { scenario: 'retired' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_private_retired());
    await expect(canvas.queryByText(head.title)).toBeNull();
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};
