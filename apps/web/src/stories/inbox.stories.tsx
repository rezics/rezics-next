import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory } from './page';

const meta = { title: 'Pages/Account/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function rowsReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('list');
}

async function emptyReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByText(m.inbox_empty());
}

function InboxStory({ fixture }: { fixture: string }) {
  return <PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />;
}

export const Empty: Story = { name: 'Empty', render: () => <InboxStory fixture="empty" />, play: emptyReady };
export const Mixed: Story = {
  name: 'Mixed replies and moderation',
  render: () => <InboxStory fixture="mixed" />,
  play: rowsReady,
};
export const Unavailable: Story = {
  name: 'Unavailable item',
  render: () => <InboxStory fixture="unavailable" />,
  play: rowsReady,
};
export const Preparing: Story = {
  name: 'Inbox preparing',
  render: () => <InboxStory fixture="preparing" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '503');
    await within(status).findByRole('button', { name: m.inbox_retry() });
    await expect(within(canvasElement).queryByText(m.inbox_empty())).toBeNull();
  },
};
export const Closed: Story = {
  name: 'Inbox closed',
  render: () => <InboxStory fixture="closed" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(status).toHaveAttribute('data-response-code', 'platform_closed');
    await within(status).findByRole('button', { name: m.inbox_retry() });
  },
};
export const UnavailableOperation: Story = {
  name: 'Inbox unavailable',
  render: () => <InboxStory fixture="unavailable-operation" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '500');
    await within(status).findByRole('button', { name: m.inbox_retry() });
    await expect(within(canvasElement).queryByText(m.inbox_empty())).toBeNull();
  },
};
export const MoreThanNinetyNine: Story = {
  name: 'More than 99 unread',
  render: () => <InboxStory fixture="many" />,
  play: rowsReady,
};
export const RowOverlay: Story = {
  name: 'Row overlay',
  render: () => <InboxStory fixture="row-overlay" />,
  play: rowsReady,
};
