import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, searchTypedReady } from './page';

const meta = { title: 'Pages/Search Typed', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: searchTypedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['search-typed']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: searchTypedReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-typed']} />,
};
