import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, boardReady, pagePaths } from './page';

const meta = { title: 'Pages/Board', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: boardReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.board} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: boardReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.board} />,
};

export const PresentationStates: Story = {
  name: 'Long and untitled thread rows',
  play: boardReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.board} />,
};
