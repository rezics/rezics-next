import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { profileSessionId, retiredSessionId } from '../kernel/fake/progress-profiles';
import { setLibraryProgressStoryMode } from '../kernel/fake/library-progress-story';
import {
  manualScalarId,
  manualSparseId,
  manualCursorId,
  manualUnresolvedId,
  manualWithheldId,
} from '../kernel/fake/progress-profile-stories';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryProgressSessionReady, pagePaths, pageReady } from './page';

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

export const EmptyChanges: Story = {
  name: 'No changes recorded',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_progress_heading() });
    await canvas.findByText(m.library_progress_changes_empty());
  },
  render: () => {
    setLibraryProgressStoryMode('detail-empty');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

export const LongContent: Story = {
  name: 'Long change history',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('Progress story change 12');
  },
  render: () => {
    setLibraryProgressStoryMode('detail-long');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

export const Unavailable: Story = {
  name: 'Unavailable',
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
  render: () => {
    setLibraryProgressStoryMode('unavailable');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

export const Error: Story = {
  name: 'Error',
  play: async (context) => {
    await pageReady(context);
    await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() });
  },
  render: () => {
    setLibraryProgressStoryMode('error');
    return <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />;
  },
};

function manualStory(id: string) {
  setLibraryProgressStoryMode('recorded');
  return <PageStory visitor="Signed In" path={`/library/progress/${id}`} />;
}

export const HistoricScalar390: Story = {
  name: 'Historic scalar, presentation unavailable at 390',
  parameters: { viewport: { defaultViewport: 'phone' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_history_unavailable());
    await canvas.findByRole('link', { name: m.library_progress_new_session() });
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
  },
  render: () => manualStory(manualScalarId),
};

export const HistoricScalar1280: Story = {
  ...HistoricScalar390,
  name: 'Historic scalar, presentation unavailable at 1280',
  parameters: { viewport: { defaultViewport: 'desktop' } },
};

export const SparseHistory: Story = {
  name: 'Three sparse keys across exact pages',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_structure_unverified());
    const units = canvas.getByRole('region', { name: m.library_progress_units() });
    expect(
      within(units)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['1', '3']);
    expect(within(units).getByRole('link', { name: m.library_progress_more() })).toBeInTheDocument();
  },
  render: () => manualStory(manualSparseId),
};

export const OpaqueCursor: Story = {
  name: 'Opaque cursor stays in its original session',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_structure_unverified());
    expect((await canvas.findAllByText('epubcfi(/6/2[old-chapter])')).length).toBeGreaterThan(0);
  },
  render: () => manualStory(manualCursorId),
};

export const UnresolvedUnit: Story = {
  name: 'Unresolved original unit remains raw',
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/historic-unit-x/);
  },
  render: () => manualStory(manualUnresolvedId),
};

export const WithheldSummaries: Story = {
  name: 'Own raw history with current summaries withheld',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByText(m.library_subject_unavailable());
    expect(canvas.queryByText('Selected version A')).not.toBeInTheDocument();
  },
  render: () => manualStory(manualWithheldId),
};
