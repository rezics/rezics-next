import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { AuthorErasurePreview } from './author-erasure-preview';
import owned from '../../../kernel/recorded/thread-owned.json';

const meta = {
  title: 'Community/Author erasure Workflow',
  id: 'patterns-community-author-erasure',
  component: AuthorErasurePreview,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Integrated thread action and operation page. Wire fixtures illustrate interactions; native authorization, enqueue and physical cleanup proof is deferred.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof AuthorErasurePreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentAdmissionUnavailable: Story = {
  args: { state: 'unavailable-entry' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.author_erasure_action() }));
    await expect(canvas.getByRole('button', { name: m.author_erasure_confirm() })).toBeDisabled();
    await expect(canvas.getByText(m.author_erasure_admission_unavailable())).toBeVisible();
  },
};
export const EnqueueLostResponse: Story = {
  args: { state: 'lost-response' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const editor = await waitFor(async () => {
      const current = canvas.getByRole('textbox', { name: m.thread_reply_label() });
      await expect(current).toHaveClass('ProseMirror');
      return current;
    });
    const post = canvasElement.querySelector<HTMLElement>(`#post-${owned.thread.firstPost.id}`)!;
    await userEvent.click(within(post).getByRole('button', { name: m.thread_reply_to_post() }));
    await userEvent.keyboard('Keep the seedlings in partial shade.');
    await userEvent.tab();
    await userEvent.click(await canvas.findByRole('button', { name: m.author_erasure_action() }));
    await expect(canvas.getByRole('button', { name: m.author_erasure_confirm() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: m.author_erasure_confirmation() }));
    await userEvent.click(canvas.getByRole('button', { name: m.author_erasure_confirm() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.author_erasure_uncertain());
    await expect(canvas.getByRole('textbox', { name: m.thread_reply_label() })).toBe(editor);
    await expect(editor).toHaveTextContent('Keep the seedlings in partial shade.');
    await expect(canvas.getByRole('button', { name: m.thread_reply_cancel_target() })).toBeVisible();
    await expect(canvas.getAllByRole('textbox', { name: m.thread_reply_label() })).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_content_more_actions() }));
    await userEvent.click(canvas.getByRole('button', { name: m.thread_content_more_actions() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.author_erasure_uncertain());
    await userEvent.click(canvas.getByRole('button', { name: m.author_erasure_retry() }));
    await expect(await canvas.findByRole('heading', { name: m.author_erasure_queued() })).toBeVisible();
    await expect(canvas.queryByText(m.author_erasure_completed())).toBeNull();
  },
};
export const RunningCounters: Story = {
  args: { state: 'running' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.author_erasure_running() })).toBeVisible();
    await expect(canvas.getByText(m.author_erasure_processed())).toBeVisible();
    await expect(canvas.getByText('19')).toBeVisible();
    await expect(canvas.queryByRole('progressbar')).toBeNull();
    await expect(
      await canvas.findByRole('button', { name: m.author_erasure_check_again() }, { timeout: 12000 }),
    ).toBeEnabled();
  },
};
export const TerminalPermissionDenial: Story = {
  args: { state: 'permission-denied' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.author_erasure_terminal_permission())).toBeVisible();
    await expect(canvas.queryByText(m.author_erasure_success())).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.author_erasure_check_again() })).toBeNull();
  },
};
export const Completed: Story = {
  args: { state: 'completed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.author_erasure_completed() })).toBeVisible();
    await expect(canvas.getByText(m.author_erasure_success())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.author_erasure_check_again() })).toBeNull();
  },
};

export const CurrentAdmissionAvailable: Story = {
  args: { state: 'available-entry' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.author_erasure_action() }));
    await expect(canvas.getByRole('button', { name: m.author_erasure_confirm() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: m.author_erasure_confirmation() }));
    await expect(canvas.getByRole('button', { name: m.author_erasure_confirm() })).toBeEnabled();
  },
};
export const CurrentAdmissionDenied: Story = {
  args: { state: 'denied-entry' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.author_erasure_action() }));
    await expect(canvas.getByRole('button', { name: m.author_erasure_confirm() })).toBeDisabled();
    await expect(canvas.getByText(m.author_erasure_forbidden())).toBeVisible();
  },
};
