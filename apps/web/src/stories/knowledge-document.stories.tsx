import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { KnowledgeDocumentPage } from '../knowledge/page';
import { knowledgeExactHref, knowledgeLiveHref } from '../knowledge/public-read';
import { m } from '../paraglide/messages.js';
import {
  knowledgeDocumentId,
  knowledgeExactRequest,
  knowledgeLiveRequest,
  knowledgeLongReady,
  knowledgeLongTitle,
  knowledgePublicationText,
  knowledgeReady,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeViewports,
} from './knowledge-document-fixtures';

const origin = 'https://site.test';
const illustrative =
  'Constructed illustrative Knowledge reader states for phone and desktop; not native public_read evidence.';

const meta = {
  title: 'Knowledge/Document reader',
  id: 'pages-knowledge-document-reader',
  component: KnowledgeDocumentPage,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    docs: { description: { story: illustrative } },
  },
  args: {
    request: knowledgeLiveRequest,
    page: knowledgeLongReady,
    origin,
  },
} satisfies Meta<typeof KnowledgeDocumentPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function tabTo(element: HTMLElement) {
  for (let step = 0; step < 40 && document.activeElement !== element; step += 1) await userEvent.tab();
  await expect(element).toHaveFocus();
}

export const LiveReady: Story = {
  name: 'Live current publication (illustrative)',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.knowledge_live_kind())).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 1, name: knowledgeLongTitle })).toBeVisible();
    await expect(canvas.getByText(knowledgePublicationText)).toBeVisible();
    await expect(canvas.getByText(m.knowledge_unattributed())).toBeVisible();
    await expect(canvas.queryByText(/anonymous|deleted/i)).toBeNull();
    const subject = canvas.getByRole('link', { name: m.knowledge_subject() });
    await expect(subject).toHaveAttribute('href', expect.stringContaining(`/subjects/${knowledgeSubjectId}/`));
    const citation = canvas.getByRole('link', {
      name: origin + knowledgeExactHref('en', knowledgeDocumentId, knowledgeRevisionId),
    });
    await expect(citation).toHaveAttribute('href', knowledgeExactHref('en', knowledgeDocumentId, knowledgeRevisionId));
    await expect(canvas.queryByRole('link', { name: m.knowledge_current_open() })).toBeNull();
    await tabTo(canvas.getByRole('button', { name: m.knowledge_citation_copy() }));
  },
};

export const ExactReady: Story = {
  name: 'Exact cited revision (illustrative)',
  args: { request: knowledgeExactRequest, page: knowledgeReady },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.knowledge_exact_kind())).toBeVisible();
    await expect(canvas.getByText(knowledgePublicationText)).toBeVisible();
    const current = canvas.getByRole('link', { name: m.knowledge_current_open() });
    await expect(current).toHaveAttribute('href', knowledgeLiveHref('en', knowledgeDocumentId));
    await tabTo(current);
  },
};

export const Preparing: Story = {
  name: 'Preparing (illustrative)',
  args: { page: { state: 'preparing' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_preparing());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByText(knowledgePublicationText)).toBeNull();
  },
};

export const NotFound: Story = {
  name: 'Not found (illustrative)',
  args: { page: { state: 'not-found', status: 404 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_not_found());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.knowledge_retry() })).toBeNull();
  },
};

export const Denied: Story = {
  name: 'Denied (illustrative)',
  args: { page: { state: 'denied', status: 403 }, onRetry: () => undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_denied());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await tabTo(canvas.getByRole('button', { name: m.knowledge_retry() }));
  },
};

export const Unavailable: Story = {
  name: 'Unavailable (illustrative)',
  args: { page: { state: 'unavailable', status: 503 }, onRetry: () => undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.knowledge_unavailable());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await tabTo(canvas.getByRole('button', { name: m.knowledge_retry() }));
  },
};

export const ExactUnavailable: Story = {
  name: 'Exact address unavailable, current opening offered (illustrative)',
  args: {
    request: knowledgeExactRequest,
    page: { state: 'not-found', status: 404 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.knowledge_not_found());
    await expect(canvas.queryByText(knowledgePublicationText)).toBeNull();
    const current = canvas.getByRole('link', { name: m.knowledge_current_open() });
    await expect(current).toHaveAttribute('href', knowledgeLiveHref('en', knowledgeDocumentId));
    await tabTo(current);
  },
};
