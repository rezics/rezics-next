import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';

const meta = { title: 'Pages/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function InboxStory({ fixture }: { fixture: string }) {
  return <PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />;
}

export const Empty: Story = { name: 'Empty', render: () => <InboxStory fixture="empty" /> };
export const Mixed: Story = { name: 'Mixed replies and moderation', render: () => <InboxStory fixture="mixed" /> };
export const Unavailable: Story = { name: 'Unavailable item', render: () => <InboxStory fixture="unavailable" /> };
export const MoreThanNinetyNine: Story = { name: 'More than 99 unread', render: () => <InboxStory fixture="many" /> };
export const RowOverlay: Story = { name: 'Row overlay', render: () => <InboxStory fixture="row-overlay" /> };
