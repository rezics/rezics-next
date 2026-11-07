import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpacePage } from '../session/community-application';
import type { SpacePageData } from '../community/space';
import { AppShell } from '../shell/shell';
import space from '../kernel/recorded/space.json';
import realm from '../kernel/recorded/realm.json';
import boards from '../kernel/recorded/realm-boards.json';
import { PatternStory } from './page';
import { exampleAccountId, RealmBansExample } from './realm-bans/example';
import { banAndUnban } from './realm-bans/realm-bans.stories';
import { communityCurrentClaim, communityCurrentClaimStory } from './community-current-claim';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Community/Realm bans', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const page: SpacePageData = {
  space: { id: space.space.spaceId, title: space.space.title, summary: space.space.summary },
  realm: {
    id: realm.realm.realmId,
    title: realm.realm.title,
    summary: realm.realm.summary,
    visibility: 'public',
    continuity: communityCurrentClaim,
    viewer: null,
    published: [],
    boards: boards.items.map((board) => ({
      id: board.id,
      title: board.title,
      purpose: 'discussion',
      visibility: 'published',
    })),
  },
};

export const ManagementJourney: Story = {
  beforeEach: communityCurrentClaimStory,
  render: () => (
    <PatternStory visitor="Signed In" path="/spaces/quiet-novel-club">
      <AppShell>
        <SpacePage page={page} realmManagement={<RealmBansExample scenario="empty" />} />
      </AppShell>
    </PatternStory>
  ),
  play: async (context) => {
    await userEvent.click(await within(context.canvasElement).findByRole('button', { name: m.community_manage() }));
    await banAndUnban(context);
    const receipt = within(context.canvasElement).getByRole('status', { name: m.realm_bans_details_lifted_heading() });
    await expect(
      within(receipt).getByRole('heading', { level: 3, name: m.realm_bans_details_lifted_heading() }),
    ).toBeVisible();
    const account = within(receipt).getByText(exampleAccountId, { exact: true });
    await expect(account).toBeVisible();
    await expect(account.closest('details')).toBeNull();
    await expect(receipt.querySelector('dt')).toHaveTextContent(m.realm_bans_details_account());
  },
};
