import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { PatternStory } from '../../page';
import { LifecycleExample } from './example';

const meta = {
  title: 'Patterns/Community/Container lifecycle',
  component: LifecycleExample,
  excludeStories: ['enterReason', 'removeAndRestore'],
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In">
        <div className="mx-auto max-w-2xl">
          <Story />
        </div>
      </PatternStory>
    ),
  ],
} satisfies Meta<typeof LifecycleExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export async function enterReason({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.type(
    await canvas.findByRole('textbox', { name: m.container_lifecycle_reason() }),
    'Repeated disruption',
  );
  await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_remove() }));
  return canvas;
}
export async function removeAndRestore(context: { canvasElement: HTMLElement }) {
  const canvas = await enterReason(context);
  await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_confirm() }));
  await canvas.findByText(m.container_lifecycle_removed());
  await userEvent.click(await canvas.findByRole('button', { name: m.container_lifecycle_restore() }));
  await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_confirm() }));
  await expect(await canvas.findByText(m.container_lifecycle_restored())).toBeVisible();
  await expect(await canvas.findByText(m.container_lifecycle_link_unavailable())).toBeVisible();
  await expect(canvas.queryByRole('link', { name: m.container_lifecycle_open() })).toBeNull();
  await expect(canvas.getByRole('textbox', { name: m.container_lifecycle_reason() })).toHaveValue(
    'Repeated disruption',
  );
}
export const Active: Story = {
  play: async (context) => {
    const canvas = await enterReason(context);
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_cancel() }));
    await expect(canvas.queryByRole('button', { name: m.container_lifecycle_confirm() })).toBeNull();
  },
};
export const RemoveAndRestore: Story = { play: removeAndRestore };
export const Removed: Story = { args: { scenario: 'removed' } };
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async (context) => {
    const canvas = await enterReason(context);
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await expect(await canvas.findByText(m.container_lifecycle_uncertain())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_retry() }));
    await expect(await canvas.findByText(m.container_lifecycle_removed())).toBeVisible();
  },
};
export const NativeDenial: Story = {
  args: { scenario: 'denied' },
  play: async (context) => {
    const canvas = await enterReason(context);
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.container_lifecycle_refused());
    const details = canvas.getByText(m.community_management_details_problem_summary());
    await userEvent.click(details);
    await expect(canvas.getByText('404')).toBeVisible();
    await expect(canvas.getByText('not_found')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.container_lifecycle_remove() })).toBeNull();
    await expect(canvas.getByRole('textbox', { name: m.container_lifecycle_reason() })).toHaveValue(
      'Repeated disruption',
    );
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async (context) => {
    const canvas = await enterReason(context);
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_confirm() }));
    await canvas.findByText(m.container_lifecycle_conflict());
    await userEvent.click(canvas.getByRole('button', { name: m.container_lifecycle_refresh() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.container_lifecycle_review() }));
    await expect(canvas.getByRole('textbox', { name: m.container_lifecycle_reason() })).toHaveValue(
      'Repeated disruption',
    );
  },
};
export const Orphaned: Story = { args: { scenario: 'orphaned' } };
export const ReadOnly: Story = { args: { scenario: 'read-only' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Loading: Story = { args: { scenario: 'loading' } };
