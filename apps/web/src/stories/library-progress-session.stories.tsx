import { within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { profileSessionId, retiredSessionId } from '../kernel/fake/progress-profiles';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressSessionReady, pagePaths } from './page';

const viewports = {
  phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
  desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
};

const meta = {
  title: 'Pages/Library/Progress Session',
  parameters: { layout: 'fullscreen', viewport: { options: viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};

export const ProfileUnits: Story = {
  name: 'Journey with profile units',
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={`/library/progress/${profileSessionId}`} />,
};
export const RetiredPair: Story = {
  name: 'Progress no longer offered',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_progress_no_longer_offered());
  },
  render: () => <PageStory visitor="Signed In" path={`/library/progress/${retiredSessionId}`} />,
};
