import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryCollectionsReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/My Collections', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryCollectionsReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-collections']} />,
};
