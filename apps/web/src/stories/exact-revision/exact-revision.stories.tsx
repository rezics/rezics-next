import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText } from '@rezics/document';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { ExactRevisionExample } from './example';
import { exactRevisionViewports, ready, selected } from './fixture';

const meta = {
  title: 'Community/Exact revision Workflow',
  id: 'patterns-community-exact-revision',
  component: ExactRevisionExample,
  parameters: { layout: 'fullscreen', viewport: { options: exactRevisionViewports } },
  args: { initial: ready },
} satisfies Meta<typeof ExactRevisionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectedRevision: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
    await expect(canvas.getByText(selected.licence, { exact: false })).toBeVisible();
    await expect(canvas.getByText('The original edition leaves room for the reader to pause.')).toBeVisible();
    const link = canvas.getByRole('link', { name: m.exact_revision_back() });
    for (let step = 0; step < 40 && document.activeElement !== link; step += 1) await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(link).toHaveAttribute('href', expect.stringContaining(selected.threadId));
  },
};
const longRevisionEnding = 'The final canonical revision paragraph remains visible in the exact edition.';
const longRevisionBody = fromPlainText(
  [
    ...Array.from(
      { length: 24 },
      (_, index) =>
        `Immutable revision paragraph ${index + 1}: the complete selected edition stays available with its original document structure.`,
    ),
    longRevisionEnding,
  ].join('\n\n'),
  'blocks',
);
export const LongDocument: Story = {
  args: { initial: { ...ready, revision: { ...ready.revision, body: longRevisionBody } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(longRevisionEnding);
    await expect(canvas.getByRole('heading', { level: 1, name: m.exact_revision_heading() })).toBeVisible();
    const frame = canvasElement.querySelector('[data-slot="content-item-frame"]');
    await expect(frame).not.toBeNull();
    await expect(frame?.className).not.toContain('line-clamp');
  },
};
export const Unavailable: Story = {
  args: { initial: { state: 'unavailable', status: 404 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.exact_revision_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.exact_revision_back() })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
export const Loading: Story = { args: { initial: { state: 'loading' } } };
export const NativeRetry: Story = {
  args: { initial: { state: 'problem', status: 503, code: 'dependency_unavailable' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.exact_revision_retry() }));
    await canvas.findByText('The original edition leaves room for the reader to pause.');
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.getByText(m.exact_revision_different_head())).toBeVisible();
  },
};
export const DifferentCurrentHead: Story = {
  args: { initial: { ...ready, thread: { ...ready.thread, differentHead: true } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.exact_revision_different_head())).toBeVisible();
    await expect(canvas.queryByText('The later edition makes the ending more explicit.')).toBeNull();
  },
};
