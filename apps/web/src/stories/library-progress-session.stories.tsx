import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { profileSession, profileSessionId, retiredSessionId } from '../kernel/fake/progress-profiles';
import { ProgressSessionPage } from '../library/progress-session';
import type { NativeProgressPresentation, ProgressSessionPage as ProgressPageData } from '../library/progress-reads';
import { setLibraryProgressStoryMode } from '../kernel/fake/library-progress-story';
import {
  manualScalarId,
  manualSparseId,
  manualCursorId,
  manualUnresolvedId,
  manualWithheldId,
} from '../kernel/fake/progress-profile-stories';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, PatternStory, libraryProgressSessionReady, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Progress Session',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryProgressSessionReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-progress-session']} />,
};

// The recorded route has no presentation. These explicit DTO inputs illustrate the delivered shape,
// without resolving history from progressProfile or claiming a native recording/authorization result.
const declaredPresentation = {
  meaning: 'known',
  unitLabel: 'segment at acceptance',
  unitLabelLanguage: 'en',
  unitCountForms: { one: 'segment at acceptance', other: 'segments at acceptance' },
  structure: 'unverified',
  recording: {
    state: 'supported',
    inputRules: { min: '0.25', max: '98.5', step: '0.01', total: 'required' },
  },
} satisfies NativeProgressPresentation;
const boundedProfilePage: ProgressPageData = {
  signedIn: true,
  idempotencyKey: '10203040-5060-4070-8090-102030405060',
  session: {
    ...profileSession,
    mode: 'scalar_amount',
    state: 'active',
    meaning: declaredPresentation.meaning,
    unitLabel: declaredPresentation.unitLabel,
    unitLabelLanguage: declaredPresentation.unitLabelLanguage,
    unitCountForms: declaredPresentation.unitCountForms,
    recordingState: declaredPresentation.recording.state,
    inputRules: declaredPresentation.recording.inputRules,
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  },
};

function DeclaredProfileView() {
  setLibraryProgressStoryMode('recorded');
  return (
    <PatternStory visitor="Signed In" path={`/library/progress/${profileSessionId}`}>
      <main className="w-full max-w-4xl space-y-6 p-4">
        <ProgressSessionPage page={boundedProfilePage} />
      </main>
    </PatternStory>
  );
}

export const ProfileUnits: Story = {
  name: 'Journey with declared profile units (bounded view)',
  parameters: {
    docs: { description: { story: 'Supplied presentation DTO. Native recording and authorization are unverified.' } },
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    await userEvent.click(within(context.canvasElement).getByRole('button', { name: m.library_progress_update() }));
    const dialog = await within(document.body).findByRole('dialog');
    const amount = within(dialog).getByRole('spinbutton', { name: m.library_progress_amount() });
    expect(amount).toHaveAttribute('min', '0.25');
    expect(amount).toHaveAttribute('max', '98.5');
    expect(amount).toHaveAttribute('step', '0.01');
  },
  render: () => <DeclaredProfileView />,
};

export const ProfileUnitsRecordingUnavailable: Story = {
  name: 'Journey route without recorded presentation',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_history_unavailable());
    await canvas.findByText(m.library_progress_recording_unavailable());
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    expect(canvas.getByText('2.5 / 10', { exact: true })).toBeVisible();
  },
  render: () => {
    setLibraryProgressStoryMode('recorded');
    return <PageStory visitor="Signed In" path={`/library/progress/${profileSessionId}`} />;
  },
};

export const DeclaredRecordingRefused: Story = {
  name: 'Current command refuses advisory support (bounded view)',
  parameters: {
    docs: { description: { story: 'Supplied presentation DTO. The current command refuses advisory support.' } },
  },
  play: async (context) => {
    await libraryProgressSessionReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_progress_update() }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    const amount = dialog.getByRole('spinbutton', { name: m.library_progress_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '3');
    await userEvent.click(dialog.getByRole('button', { name: m.library_progress_record() }));
    await canvas.findByRole('alert');
    await canvas.findByText(m.library_progress_no_longer_offered());
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
    expect(canvas.getByText('2.5 / 10 segments at acceptance', { exact: true })).toBeVisible();
  },
  render: () => <DeclaredProfileView />,
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

export const HistoricScalar: Story = {
  name: 'Historic scalar, presentation unavailable',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_history_unavailable());
    await canvas.findByRole('link', { name: m.library_progress_new_session() });
    expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument();
  },
  render: () => manualStory(manualScalarId),
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
