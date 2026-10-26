import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryLogReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Published Log', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryLogReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-log']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: libraryLogReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['library-log']} />,
};
