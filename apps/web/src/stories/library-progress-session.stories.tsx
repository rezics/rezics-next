import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressSessionReady, libraryProgressUpdateOpen, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Pages/Library/Progress Session',
  parameters: { layout: 'fullscreen', viewport: { viewports, defaultViewport: 'phone' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};

export const Desktop: Story = {
  name: 'Session at 1280',
  parameters: { viewport: { defaultViewport: 'desktop' } },
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};

export const UpdateFormOpen: Story = {
  name: 'Update form open at 390',
  play: libraryProgressUpdateOpen,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};
