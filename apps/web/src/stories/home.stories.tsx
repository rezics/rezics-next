import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Home', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.home} />,
};
