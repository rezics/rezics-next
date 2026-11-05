import { expect, userEvent, within } from 'storybook/test';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense } from 'react';
import { ProgressIndexPage } from '../library/progress-page';
import { readProgressIndex } from '../library/progress-server';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import {
  libraryProgressStoryLongSubjectLabel,
  libraryProgressStoryNextCursor,
  libraryProgressStoryRequestCursor,
  setLibraryProgressStoryMode,
  type LibraryProgressStoryMode,
} from '../kernel/fake/library-progress-story';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { unprofiledSubjectId } from '../kernel/fake/library-unprofiled-subject';
import { PageStory, PatternStory, exposureStory, libraryProgressReady, pagePaths } from './page';

const meta = {
  title: 'Pages/Library/Progress',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ProgressStory(mode: LibraryProgressStoryMode, path: string = pagePaths['library-progress']) {
  setLibraryProgressStoryMode(mode);
  return <PageStory visitor="Signed In" path={path} />;
}
export const SignedIn: Story = {
  name: 'Owner',
  play: libraryProgressReady,
  render: () => ProgressStory('recorded'),
};

export const ExposureOpen: Story = exposureStory(pagePaths['library-progress']);
export const ExposureClosed: Story = exposureStory(pagePaths['library-progress'], true);

export const SelectorSheetOpen: Story = {
  name: 'Profile unit selector focused',
  play: async (context) => {
    await libraryProgressReady(context);
    const selector = await within(context.canvasElement).findByRole('combobox', { name: m.library_progress_unit() });
    selector.focus();
    await expect(selector).toHaveFocus();
  },
  render: () => ProgressStory('recorded'),
};

export const Empty: Story = {
  render: () => ProgressStory('none'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('main');
    await canvas.findByText(m.library_progress_empty());
    expect(canvas.queryByRole('link', { name: m.library_collections_first_page() })).not.toBeInTheDocument();
  },
};

// Authored recovery/disclosure stories are UNRUN; controller owns browser verification.
export const LaterPageEmpty: Story = {
  name: 'Empty later page with first page recovery',
  render: () => ProgressStory('none', '/library/progress?cursor=earlier%2Fopaque%2B%3D%3D'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_page_empty());
    const first = await canvas.findByRole('link', { name: m.library_collections_first_page() });
    const target = new URL(first.getAttribute('href')!, window.location.origin);
    expect(target.pathname).toBe(`/${getLocale()}/library/progress`);
    expect(target.searchParams.has('cursor')).toBe(false);
    expect(target.searchParams.get('subjectId')).toBe('');
    expect(canvas.queryByText(m.library_progress_empty())).not.toBeInTheDocument();
  },
};

export const FilteredLaterPageEmpty: Story = {
  name: 'Empty later page retains the subject filter',
  render: () => ProgressStory('none', `${pagePaths['library-progress']}&cursor=earlier%2Fopaque%2B%3D%3D`),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_progress_page_empty());
    const first = await canvas.findByRole('link', { name: m.library_collections_first_page() });
    const target = new URL(first.getAttribute('href')!, window.location.origin);
    const original = new URL(pagePaths['library-progress'], window.location.origin);
    expect(target.pathname).toBe(`/${getLocale()}/library/progress`);
    expect(target.searchParams.get('subjectId')).toBe(original.searchParams.get('subjectId'));
    expect(target.searchParams.has('cursor')).toBe(false);
    expect(canvas.queryByText(m.library_progress_empty())).not.toBeInTheDocument();
  },
};

function UnknownUnitLongText() {
  const subjectId = new URL(pagePaths['library-progress'], window.location.origin).searchParams.get('subjectId')!;
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'progress-index-unknown-unit', subjectId, getLocale()],
    queryFn: () => readProgressIndex({ data: { subjectId } }),
  });
  const page = {
    ...data,
    sessions: data.sessions.map(({ unitLabel: _unitLabel, ...session }) => {
      const subject = session.subject;
      if (!subject) return session;
      const label = typeof subject.label === 'string' ? subject.label : subject.label.value;
      const longLabel = `${label} — ${label} — ${label} — ${label}`;
      return {
        ...session,
        subject: {
          ...subject,
          label: typeof subject.label === 'string' ? longLabel : { ...subject.label, value: longLabel },
        },
      };
    }),
  };
  return <ProgressIndexPage page={page} />;
}

function UnknownUnitStory() {
  setLibraryProgressStoryMode('recorded');
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-progress']}>
      <main className="w-full max-w-4xl p-4">
        <Suspense fallback={null}>
          <UnknownUnitLongText />
        </Suspense>
      </main>
    </PatternStory>
  );
}

export const UnknownUnitNarrow: Story = {
  name: 'Unknown unit with long titles',
  parameters: {
    docs: {
      description: {
        story:
          'Recorded page with unit labels omitted and repeated titles for text wrapping. Native operands and returned order are retained. UNRUN.',
      },
    },
  },
  render: () => <UnknownUnitStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByText(m.library_progress_unit_unspecified());
    const details = canvasElement.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(m.library_history_unavailable())).not.toBeVisible();
    expect(details.querySelector('code')).not.toBeVisible();
    expect(details.querySelector('dt')?.textContent).toBe(
      `${m.library_progress_mode()} / ${m.library_progress_unit()}`,
    );
  },
};

export const UnknownUnitDetailsOpen: Story = {
  ...UnknownUnitNarrow,
  name: 'Optional native progress details opened by keyboard',
  play: async (context) => {
    await UnknownUnitNarrow.play?.(context);
    const details = context.canvasElement.querySelector('details')!;
    details.querySelector('summary')!.focus();
    await userEvent.keyboard('{Enter}');
    expect(details).toHaveAttribute('open');
    expect(details.querySelector('code')).toBeVisible();
    expect(within(details).getByText(m.library_history_unavailable())).toBeVisible();
    expect(details.querySelector('code')?.textContent).toBe('cursor_position / chapter');
  },
};

export const UnknownUnitConstructedIdentityIndex: Story = {
  name: 'Unknown unit and long supplied identity on the routed index',
  parameters: {
    docs: {
      description: {
        story:
          'Constructed consumer-response examples derived from the existing recording. The long label repeats a supplied subject label; stored mode, unit, amount and position stay unchanged, and null subjects stay null. Browser rendering, physical keyboard, target size and native results remain unmeasured.',
      },
    },
  },
  render: () =>
    ProgressStory(
      'constructed-unknown-identity',
      `${pagePaths['library-progress']}&cursor=${encodeURIComponent(libraryProgressStoryRequestCursor)}`,
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('main');
    const rows = canvasElement.querySelectorAll('ol > li');
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;
    if (libraryProgressStoryLongSubjectLabel) await canvas.findByText(libraryProgressStoryLongSubjectLabel);
    const warning = await canvas.findByText(m.library_progress_index_reader_history_unavailable());
    expect(warning).toBeVisible();
    const details = first.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('code')).not.toBeVisible();
    expect(details.querySelector('dt')?.textContent).toBe(
      `${m.library_progress_mode()} / ${m.library_progress_unit()}`,
    );

    const next = await canvas.findByRole('link', { name: m.library_progress_more() });
    const target = new URL(next.getAttribute('href')!, window.location.origin);
    const original = new URL(pagePaths['library-progress'], window.location.origin);
    expect(target.pathname).toBe(`/${getLocale()}/library/progress`);
    expect(target.searchParams.get('subjectId')).toBe(original.searchParams.get('subjectId'));
    expect(target.searchParams.get('cursor')).toBe(libraryProgressStoryNextCursor);

    details.querySelector('summary')!.focus();
    await userEvent.keyboard('{Enter}');
    expect(details).toHaveAttribute('open');
    expect(details.querySelector('code')?.textContent).toBe('cursor_position / chapter');
  },
};

export const LongContent: Story = {
  render: () => ProgressStory('long', '/library/progress'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Progress story 1');
    await canvas.findByText('Progress story 12');
  },
};

export const Unavailable: Story = {
  render: () => ProgressStory('unavailable'),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('main');
    expect(within(canvasElement).queryByText(m.library_progress_empty())).not.toBeInTheDocument();
  },
};

export const Error: Story = {
  render: () => ProgressStory('error'),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('main');
    expect(within(canvasElement).queryByText(m.library_progress_empty())).not.toBeInTheDocument();
  },
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

export const ExplicitVersionChoice: Story = {
  name: 'Choose a readable version reference for a new session',
  play: async (context) => {
    await libraryProgressReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('combobox', { name: m.library_progress_version() });
    await canvas.findByText(m.library_progress_version_scope());
    await canvas.findByText(m.library_progress_new_session_scope());
    await canvas.findByText(m.library_progress_no_version());
  },
  render: () => ProgressStory('recorded'),
};
