import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressSessionReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Progress Session', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};
