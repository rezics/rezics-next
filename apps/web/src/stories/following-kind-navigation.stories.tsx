import type { Meta, StoryObj } from '@storybook/react-vite';
import { MineFollowingPageView } from '../library/mine-following-page';

const meta = {
  title: 'Library/Following kind navigation',
  id: 'pages-library-following-kind-navigation',
  component: MineFollowingPageView,
  parameters: { layout: 'fullscreen' },
  args: { page: { signedIn: true, follows: [], next: null, kindUnavailable: true }, kind: 'space' },
} satisfies Meta<typeof MineFollowingPageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {};
export const PhoneUnavailable: Story = { tags: ['!dev'], globals: {} };
export const PreviousAvailable: Story = {
  args: {
    page: { signedIn: true, follows: [], next: 'opaque/next+' },
    cursor: 'opaque/current+',
    kind: 'subject',
    navigation: {
      previous: { cursor: null, kind: 'subject' },
      busy: false,
      unsettledRemoval: false,
      move: () => true,
      removalChanged: () => {},
    },
  },
};
