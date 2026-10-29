import { within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressReady, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Pages/Library/Progress',
  parameters: { layout: 'fullscreen', viewport: { viewports, defaultViewport: 'phone' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryProgressReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress']} />,
};

export const Desktop: Story = {
  name: 'Progress list at 1280',
  parameters: { viewport: { defaultViewport: 'desktop' } },
  play: libraryProgressReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress']} />,
};

export const SelectorSheetOpen: Story = {
  name: 'Profile unit selector at 390',
  play: async (context) => {
    await libraryProgressReady(context);
    (await within(context.canvasElement).findByRole('combobox', { name: m.library_progress_unit() })).focus();
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress']} />,
};
