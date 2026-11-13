import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { KnowledgeDiscoveryPanel } from '../knowledge/discovery-panel';
import { knowledgeDiscoveryExactHref, type KnowledgeDiscoveryDocument } from '../knowledge/discovery';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import {
  knowledgeDocumentId,
  knowledgeLicence,
  knowledgePublicationId,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeTitle,
  knowledgeViewports,
} from './knowledge-document-fixtures';

const visitHref = `/en/subjects/${knowledgeSubjectId}/selected-public-knowledge`;
const secondDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const secondRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000022';
const longTitle = 'A published analysis whose wrapped title must remain readable on a 390px phone and a 1280px desktop';

function published(overrides: Partial<KnowledgeDiscoveryDocument> = {}): KnowledgeDiscoveryDocument {
  return {
    subjectId: knowledgeSubjectId,
    documentId: knowledgeDocumentId,
    publicationId: knowledgePublicationId,
    revisionId: knowledgeRevisionId,
    publishedAt: '2026-10-30T12:00:00.000Z',
    title: knowledgeTitle,
    language: 'en',
    licence: knowledgeLicence,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

const illustrative =
  'Constructed illustrative Knowledge discovery states for phone and desktop; not native Search evidence.';

const meta = {
  title: 'Knowledge/Discovery',
  id: 'pages-knowledge-discovery',
  component: KnowledgeDiscoveryPanel,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: { description: { story: illustrative } },
  },
  args: {
    locale: 'en' satisfies Locale,
    returnTo: visitHref,
    snapshot: {
      state: 'ready' as const,
      cursor: null,
      busy: false,
      page: {
        documents: [
          published({ title: longTitle }),
          published({
            documentId: secondDocumentId,
            revisionId: secondRevisionId,
            publicationId: '0192f3a0-6c1e-7b2a-9d4e-000000000023',
            title: 'Second published contribution in supplied order',
            language: null,
          }),
        ],
        next: 'opaque+/=frontier',
      },
    },
  },
} satisfies Meta<typeof KnowledgeDiscoveryPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

async function tabTo(element: HTMLElement) {
  for (let step = 0; step < 40 && document.activeElement !== element; step += 1) await userEvent.tab();
  await expect(element).toHaveFocus();
}

export const Populated: Story = {
  name: 'Populated (illustrative)',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: m.knowledge_discovery_heading() })).toBeVisible();
    const first = canvas.getByRole('link', { name: longTitle });
    await expect(first).toHaveAttribute(
      'href',
      knowledgeDiscoveryExactHref(
        'en',
        { documentId: knowledgeDocumentId, revisionId: knowledgeRevisionId },
        visitHref,
      ),
    );
    await expect(canvas.getByRole('link', { name: 'Second published contribution in supplied order' })).toBeVisible();
    await expect(canvas.queryByText(/author|anonymous|notebook/i)).toBeNull();
    await tabTo(canvas.getByRole('button', { name: m.knowledge_discovery_more() }));
  },
};

export const Preparing: Story = {
  name: 'Preparing (illustrative)',
  args: {
    snapshot: { state: 'preparing', cursor: 'opaque-prep', frontier: 'opaque+/=next', busy: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_discovery_preparing());
    await tabTo(canvas.getByRole('button', { name: m.knowledge_discovery_continue() }));
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const Sparse: Story = {
  name: 'Sparse (illustrative)',
  args: {
    snapshot: {
      state: 'ready',
      cursor: 'opaque-sparse',
      busy: false,
      page: { documents: [], next: 'opaque+/=more' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_discovery_sparse());
    await tabTo(canvas.getByRole('button', { name: m.knowledge_discovery_more() }));
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const Empty: Story = {
  name: 'Empty (illustrative)',
  args: {
    snapshot: { state: 'ready', cursor: null, busy: false, page: { documents: [], next: null } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_discovery_empty());
    await expect(canvas.queryByRole('button', { name: m.knowledge_discovery_more() })).toBeNull();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const Unavailable: Story = {
  name: 'Unavailable (illustrative)',
  args: {
    snapshot: { state: 'unavailable', status: 503, cursor: 'opaque-failed', busy: false },
    onRetry: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.knowledge_discovery_unavailable());
    await tabTo(canvas.getByRole('button', { name: m.knowledge_discovery_retry() }));
  },
};
