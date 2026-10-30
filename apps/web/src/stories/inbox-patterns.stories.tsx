import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { UnreadBadgeView } from '../inbox/unread-badge';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Account/Inbox',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function Example({ fixture }: { fixture: string }) {
  return (
    <PatternStory visitor="Signed In" path={`/inbox?fixture=${fixture}`}>
      <InboxPageView />
    </PatternStory>
  );
}
export const NativeRows: Story = {
  render: () => <Example fixture="mixed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = within(await view.findByRole('list'));
    await expect(list.getAllByRole('listitem')).toHaveLength(3);
    await userEvent.tab();
    await expect(list.getAllByRole('link')[0]).toHaveFocus();
  },
};
export const Empty: Story = {
  render: () => <Example fixture="empty" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.inbox_empty());
  },
};
export const DependencyUnavailable: Story = {
  render: () => <Example fixture="unavailable-operation" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.inbox_retry() }));
    await view.findByText(m.inbox_unavailable());
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
  },
};
export const HiddenTarget: Story = {
  render: () => <Example fixture="unavailable" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    await list.findByText(m.inbox_unavailable_item());
    await expect(list.queryByRole('link')).toBeNull();
  },
};
export const UnreadUnavailable: Story = {
  render: () => (
    <div className="p-4">
      <a href="#inbox-preview" className="inline-flex items-center gap-3">
        {m.inbox_heading()}
        <UnreadBadgeView data={{ signedIn: true, state: 'unavailable', failure: { status: 503 } }} />
      </a>
      <div id="inbox-preview">
        <Example fixture="mixed" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('img', { name: m.inbox_unread_unavailable() })).toBeEmptyDOMElement();
    await userEvent.click(view.getByRole('link', { name: new RegExp(m.inbox_heading()) }));
    await view.findByRole('list');
  },
};

export const ModeratorResponse: Story = {
  render: () => <Example fixture="report-moderator" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    await list.findByText(m.inbox_unavailable_item());
    await expect(list.queryByRole('link')).toBeNull();
    await expect(list.queryByText('Repeated advertising in this discussion.')).toBeNull();
  },
};
