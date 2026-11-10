import type { Meta } from '@storybook/react-vite';
import { PageStory, boardReady, pagePaths } from './page';
import { ContinueHot as continuation } from './board-continuation.stories';
import realmBoard from '../kernel/recorded/board-realm.json';
import { appearancePath } from '../kernel/fake/community';
import { communityCurrentClaimStory } from './community-current-claim';

const meta = { title: 'Community/Community Board', id: 'pages-community-community-board', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
export const Global = { render: () => <PageStory visitor="Signed In" path={pagePaths.board} />, play: boardReady };
export const Realm = { render: () => <PageStory visitor="Signed In" path={`/boards/${realmBoard.board.id}`} /> };
export const ContinueHot = { ...continuation };
export const SpaceHomeSignedOut = { render: () => <PageStory visitor="Signed Out" path={appearancePath} /> };
export const SpaceHomeMember = {
  beforeEach: communityCurrentClaimStory,
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
};
export const SpaceHomeSourceUnavailable = {
  beforeEach: communityCurrentClaimStory,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-plain" />,
};
export const SpaceHomeMembershipUnavailable = {
  beforeEach: communityCurrentClaimStory,
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-unavailable" />,
};
