import type { Meta, StoryObj } from '@storybook/react-vite';
import { within } from 'storybook/test';
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
