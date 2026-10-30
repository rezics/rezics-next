import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, exposureStory, libraryProgressReady, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Pages/Library/Progress',
  parameters: { layout: 'fullscreen', viewport: { options: viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryProgressReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress']} />,
};

export const ExposureOpen: Story = exposureStory(pagePaths['library-progress']);
export const ExposureClosed: Story = exposureStory(pagePaths['library-progress'], true);
