import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pageReady, pages } from './page';

const meta = { title: 'Pages/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In">{pages.subject}</PageStory>,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out">{pages.subject}</PageStory>,
};
