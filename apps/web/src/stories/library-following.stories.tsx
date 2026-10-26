import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryFollowingReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Following', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryFollowingReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-following']} />,
};
