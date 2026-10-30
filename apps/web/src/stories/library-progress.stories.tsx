import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
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

export const UnsupportedProfile: Story = {
  name: 'No choices for an unprofiled subject',
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('status', { name: m.library_progress_unsupported() });
    expect(view.queryByLabelText(m.library_progress_unit())).not.toBeInTheDocument();
  },
  render: () => (
    <PageStory visitor="Signed In" path={`/library/progress?subjectId=${encodeURIComponent(unprofiledSubjectId)}`} />
  ),
};
