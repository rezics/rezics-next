import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Progress', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryProgressReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress']} />,
};
