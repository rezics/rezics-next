import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { presentContinuePage, type NativeContinuePage } from '../library/continue-adapter';
import { ContinueSection } from '../library/continue';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Library/Continue Native Binding',
  id: 'patterns-library-continue-native-binding',
  parameters: { layout: 'fullscreen', admitted: ['personal_library', 'reading_progress'] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// Illustrative records in the delivered DTO shape, solely for presentation. No native Source/readiness evidence.
const full: NativeContinuePage = {
  subjects: [
    {
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
      state: null,
      lastActivityAt: '2026-10-31T00:00:00.123456Z',
      activeProgressSession: {
        id: '0192f3a0-6c1e-7b2a-9d4e-000000000011',
        subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
        versionSubjectId: null,
        mode: 'completed_units',
        unit: 'chapter',
        total: null,
        amount: null,
        locator: null,
        position: null,
        completedUnitCount: 3,
        state: 'active',
        revision: 2,
        startedAt: '2026-10-30T00:00:00Z',
        completedAt: null,
      },
      subject: {
        id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
        type: 'schema:Book',
        types: ['schema:Book', 'schema:CreativeWork'],
        label: { value: 'Selected chapters', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
    {
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
      state: 'unlabelled-accepted-state',
      lastActivityAt: '2026-10-30T00:00:00.123456Z',
      activeProgressSession: null,
      subject: {
        id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
        type: 'schema:Book',
        types: ['schema:Book'],
        label: { value: 'State without a session', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
  ],
  next: 'opaque+/next==',
};

function illustrate(input: NativeContinuePage): Story {
  return {
    render: () => (
      <PatternStory visitor="Signed In">
        <div className="mx-auto max-w-7xl p-4 sm:p-8">
          <ContinueSection destination state={presentContinuePage(input)} locale={getLocale()} />
        </div>
      </PatternStory>
    ),
  };
}

export const FullProjection: Story = {
  ...illustrate(full),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: m.library_next_page() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library/continue?cursor=${encodeURIComponent(full.next!)}`,
    );
    await expect(canvas.queryByText('unlabelled-accepted-state')).toBeNull();
  },
};

export const WithheldHeader: Story = {
  ...illustrate({ ...full, subjects: [{ ...full.subjects[0]!, subject: null }] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_continue_unavailable());
    await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    await expect(canvas.queryByText('Selected chapters')).toBeNull();
  },
};

export const UnlabelledSubject: Story = illustrate({
  subjects: [{ ...full.subjects[1]!, subject: { ...full.subjects[1]!.subject!, label: null } }],
  next: null,
});
