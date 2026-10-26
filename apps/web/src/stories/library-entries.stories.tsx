import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryEntriesReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Personal Library', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
