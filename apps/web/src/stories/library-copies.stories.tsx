import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryCopiesReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Copies', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryCopiesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-copies']} />,
};
