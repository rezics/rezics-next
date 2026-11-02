import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import realmBoardsRecording from '../kernel/recorded/realm-boards.json';
import spaceRecording from '../kernel/recorded/space.json';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';
import { communityCurrentClaimStory } from './community-current-claim';

const meta = {
  title: 'Pages/Community/Space',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One native community identity with adjacent Follow and Join/Leave, then boards and published subjects. A distinct routed Space stays compact context. Manage community requires current native operation admission; its controls remain mounted when closed and reset for a changed viewer or Realm. Public readers see no private management dashboards.',
      },
    },
  },
  beforeEach: communityCurrentClaimStory,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Space's title, the Realm's boards and a published subject are on the page. */
async function spaceReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
  const board = realmBoardsRecording.items[0]?.title;
  if (!board) throw new Error('The recorded Realm has no board.');
  await view.findByRole('link', { name: new RegExp(board) });
  await expect(view.queryByRole('heading', { name: m.realm_appearance_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.realm_bans_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.realm_claim_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.container_lifecycle_space() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.container_lifecycle_realm() })).toBeNull();
  const firstRow = (await view.findAllByRole('listitem'))[0]!;
  await userEvent.hover(firstRow);
  firstRow.setAttribute('data-overlay', 'visible');
}

export const SignedIn: Story = {
  name: 'Banner, Non-member',
  play: spaceReady,
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-non-member" />,
};
export const SignedOut: Story = {
  name: 'Banner, Signed Out',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-banner" />,
};
export const NoBanner: Story = {
  name: 'No Banner',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-plain" />,
};
export const Member: Story = {
  name: 'Banner, Member',
  play: async (context) => {
    await spaceReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const membership = within(view.getByRole('region', { name: m.realm_membership_label() }));
    await expect(await membership.findByRole('button', { name: m.realm_leave() })).toBeEnabled();
    await expect(membership.getByText(m.realm_state_member())).toBeVisible();
    await expect(membership.queryByRole('button', { name: m.realm_join() })).toBeNull();
    for (const board of realmBoardsRecording.items)
      await expect(view.getByRole('link', { name: board.title })).toBeVisible();
    await expect(view.getByRole('heading', { name: m.realm_published_heading() })).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
    await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
  },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
};

export const Unavailable: Story = {
  name: 'Membership and published subject unavailable',
  play: async (context) => {
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
    const board = realmBoardsRecording.items[0]?.title;
    if (!board) throw new Error('The recorded Realm has no board.');
    await view.findByRole('link', { name: new RegExp(board) });
    await view.findByRole('heading', { level: 2, name: m.realm_published_heading() });
    const membership = within(view.getByRole('region', { name: m.realm_membership_label() }));
    await expect(await membership.findByRole('status')).toHaveTextContent(m.realm_membership_unavailable());
    await expect(view.queryByRole('button', { name: m.realm_join() })).toBeNull();
    await expect(view.getByText(m.realm_published_unavailable())).toBeVisible();
    await expect(view.queryByText(m.realm_published_empty())).toBeNull();
  },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-unavailable" />,
};

/** An unavailable board-list response becomes an error page, not a false empty state. */
export const BoardsUnavailable: Story = {
  name: 'Boards request unavailable',
  play: async (context) => {
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: m.error_heading() });
    await expect(view.queryByText(m.realm_boards_empty())).toBeNull();
    await expect(
      view.queryByRole('link', { name: new RegExp(realmBoardsRecording.items[0]?.title ?? 'missing') }),
    ).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-boards-unavailable" />,
};
