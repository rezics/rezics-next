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
  knowledgePublicationId,
  knowledgeSubjectId,
  knowledgeViewports,
} from './knowledge-document-fixtures';
import { m } from '../paraglide/messages.js';
import { locales, setLocale, type Locale } from '../paraglide/runtime.js';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const revisionB = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const csrfToken = 'illustrative-publication-session';
const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'illustrative-publication-visit',
  read: 'available',
  createNotebook: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'available',
};
type Scenario = 'Review' | 'PublishedWithNewDraft' | 'Conflict' | 'Uncertain' | 'Withdrawn';

function illustrativeOperations(scenario: Scenario): KnowledgePrivateOperations {
  let head: KnowledgePrivateHead = {
    accountId: viewer,
    notebookId,
    documentId: knowledgeDocumentId,
    revisionId: knowledgeRevisionId,
    publicationId: scenario === 'Withdrawn' ? knowledgePublicationId : null,
    title: 'How a character changes across a scene',
    language: 'en',
    licence: 'CC-BY-SA-4.0',
    subjectIds: [knowledgeSubjectId],
    body: knowledgeBody(
      'The scene begins with an avoided decision. A small promise changes what the character is willing to risk. This saved analysis can be reviewed independently of later private notes.',
    ),
  };
  return {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential: 'illustrative-captured-credential' }),
    read: async () => ({ state: 'ready', viewer, csrfToken, credential: 'illustrative-captured-credential', head }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async (intent) => {
      head = {
        ...head,
        title: intent.title,
        language: intent.language,
        body: intent.body,
        licence: intent.licence,
        revisionId: revisionB,
      };
      return { state: 'acknowledged', receipt: { documentId: head.documentId, revisionId: head.revisionId } };
    },
    selectPublication: async (intent) => {
      if (scenario === 'Conflict') return { state: 'conflict', status: 412 };
      if (scenario === 'Uncertain') return { state: 'uncertain' };
      head = { ...head, publicationId: intent.revisionId === null ? null : knowledgePublicationId };
      return {
        state: 'acknowledged',
        receipt: { documentId: head.documentId, publicationId: head.publicationId, revisionId: intent.revisionId },
      };
    },
  };
}

function PublicationExample({ scenario, locale }: { scenario: Scenario; locale: Locale }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  );
  const operations = useMemo(() => illustrativeOperations(scenario), [scenario]);
  const router = useMemo(() => {
    function Visit() {
      return (
        <KnowledgePrivateAccessEntry
          address={{ kind: 'resume', notebookId, documentId: knowledgeDocumentId }}
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
  title: 'Pages/Knowledge/Publication',
  component: PublicationExample,
  args: { scenario: 'Review', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { options: locales, control: 'select' } },
  globals: { visitor: 'Signed In' },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative saved-head publication states in the signed-in private editor. Inspect phone390 and desktop1280 in both themes and all eight locales. Native publication, browser and visual proof remain with integration’s retained seeded lane.',
      },
    },
  },
} satisfies Meta<typeof PublicationExample>;
export default meta;
type Story = StoryObj<typeof meta>;

async function review(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const button = await canvas.findByRole('button', { name: m.knowledge_publication_review() });
  await userEvent.click(button);
  await expect(canvas.getByText(m.knowledge_publication_private_review())).toBeVisible();
  return canvas;
}

export const Review: Story = {
  args: { scenario: 'Review' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    const confirm = canvas.getByRole('button', { name: m.knowledge_publication_confirm() });
    await expect(confirm).toBeEnabled();
    confirm.focus();
    await expect(confirm).toHaveFocus();
  },
};
export const PublishedWithNewDraft: Story = {
  args: { scenario: 'PublishedWithNewDraft' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_publication_confirm() }));
    await canvas.findByRole('link', { name: m.knowledge_publication_exact() });
    const title = canvas.getByLabelText(m.knowledge_private_document_title(), { selector: 'input' });
    await userEvent.clear(title);
    await userEvent.type(title, 'A later private analysis');
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_private_save() }));
    await expect(await canvas.findByText(m.knowledge_publication_new_draft())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.knowledge_publication_exact() })).toHaveAttribute(
      'href',
      `/en/knowledge/documents/${knowledgeDocumentId}?revisionId=${knowledgeRevisionId}`,
    );
  },
};
export const Conflict: Story = {
  args: { scenario: 'Conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_publication_confirm() }));
    await expect(await canvas.findByText(m.knowledge_publication_conflict())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_publication_reread() })).toBeEnabled();
  },
};
export const Uncertain: Story = {
  args: { scenario: 'Uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_publication_confirm() }));
    await expect(await canvas.findByText(m.knowledge_publication_uncertain())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.knowledge_publication_replay() })).toBeEnabled();
  },
};
export const Withdrawn: Story = {
  args: { scenario: 'Withdrawn' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.knowledge_publication_withdraw_review() }));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_publication_confirm_withdraw() }));
    await expect(await canvas.findByText(m.knowledge_publication_withdrawn())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.knowledge_publication_exact() })).toBeNull();
  },
};
