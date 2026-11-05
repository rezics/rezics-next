import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ProgressIndexPage } from '../library/progress-page';
import type { ProgressIndex } from '../library/progress-reads';
import { subjectOf } from '../library/reads';
import recorded from '../kernel/recorded/library-progress-sessions.json';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Library/Progress discovery',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Session = ProgressIndex['sessions'][number];
const actions = {
  open: { allowed: true, reason: null },
  edit: { allowed: true, reason: null },
  complete: { allowed: true, reason: null },
  abandon: { allowed: true, reason: null },
} as const;
function mode(value: string): Session['mode'] {
  if (value === 'scalar_amount' || value === 'cursor_position' || value === 'completed_units') return value;
  throw new Error('Recorded progress story has an unsupported mode');
}
function state(value: string): Session['state'] {
  if (value === 'active' || value === 'completed' || value === 'abandoned') return value;
  throw new Error('Recorded progress story has an unsupported state');
}
const sessions: Session[] = recorded.progressSessions.map((row) => ({
  id: row.id,
  subjectId: row.subjectId,
  versionSubjectId: row.versionSubjectId,
  mode: mode(row.mode),
  unit: row.unit,
  total: row.total,
  amount: row.amount,
  locator: row.locator,
  position: row.position,
  completedUnitCount: row.completedUnitCount,
  state: state(row.state),
  revision: row.revision,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  subject: subjectOf(row.subject),
  versionSubject: null,
  meaning: 'known',
  recordingState: 'unavailable',
  unitLabel: row.unit,
  allowedActions: actions,
}));
const first = sessions[0]!;
const other = sessions[1]!;
const repeat: Session = {
  ...first,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
  state: 'completed',
  revision: first.revision + 1,
  startedAt: '2026-10-27T10:00:00.000Z',
  completedAt: '2026-10-27T10:30:00.000Z',
};
const key = '0192f3a0-6c1e-7b2a-9d4e-000000000098';
function page(overrides: Partial<ProgressIndex> = {}): ProgressIndex {
  return {
    signedIn: true,
    viewerState: 'signed_in',
    subjectId: '',
    selectedSubject: null,
    sessions: [first, other, repeat],
    next: null,
    idempotencyKey: key,
    ...overrides,
  };
}
function Discovery({ value, cursor }: { value: ProgressIndex; cursor?: string }) {
  return (
    <PatternStory visitor={value.signedIn ? 'Signed In' : 'Signed Out'} path="/library/progress">
      <main className="w-full max-w-4xl p-4">
        <ProgressIndexPage page={value} {...(cursor === undefined ? {} : { cursor })} />
      </main>
    </PatternStory>
  );
}

export const OwnerWide: Story = {
  name: 'Owner wide list preserves repeated sessions',
  render: () => <Discovery value={page()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.library_progress_heading() });
    expect(canvasElement.querySelectorAll('ol > li')).toHaveLength(3);
    await canvas.findByText('Kokoro');
    await canvas.findByText('The Tale of Genji');
  },
};

export const ExactSubject: Story = {
  name: 'Exact subject filter',
  render: () => (
    <Discovery
      value={page({
        subjectId: first.subjectId,
        selectedSubject: first.subject,
        sessions: [first, repeat],
      })}
    />
  ),
};

export const StateFilter: Story = {
  name: 'State filter with an independent completed occurrence',
  render: () => <Discovery value={page({ state: 'completed', sessions: [repeat] })} />,
};

export const ModeFilter: Story = {
  name: 'Mode filter',
  render: () => <Discovery value={page({ mode: 'scalar_amount', sessions: [other] })} />,
};

export const NoMatches: Story = {
  name: 'No matches for selected filters',
  render: () => <Discovery value={page({ profileId: 'missing-profile', sessions: [], emptyKind: 'filtered-empty' })} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_progress_discovery_empty_filtered());
  },
};

export const SignedOut: Story = {
  name: 'Signed out',
  render: () => <Discovery value={page({ signedIn: false, viewerState: 'signed_out', sessions: [] })} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_progress_discovery_signed_out());
  },
};

export const ConcealedWork: Story = {
  name: 'Private session with unavailable work destination',
  render: () => <Discovery value={page({ sessions: [{ ...first, subject: null, versionSubject: null }] })} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_subject_unavailable());
    expect(canvasElement.querySelectorAll('a[href*="/subjects/"]')).toHaveLength(0);
    expect(canvasElement.querySelector(`a[href*="/library/progress/${first.id}"]`)).not.toBeNull();
  },
};

export const IndexUnavailable: Story = {
  name: 'Index unavailable',
  render: () => <Discovery value={page({ viewerState: 'unavailable', sessions: [] })} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.library_progress_unavailable());
  },
};

export const InvalidatedContinuation: Story = {
  name: 'Continuation invalidated by a changed owner index',
  render: () => <Discovery value={page({ staleContinuation: true, sessions: [] })} cursor="earlier/opaque+==" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_discovery_stale());
    await canvas.findByRole('link', { name: m.library_collections_first_page() });
  },
};
