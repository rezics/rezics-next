import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PersonalLibraryPage } from '../library/entries-page';
import { continueProgress } from '../library/continue-read';
import type { ContinueView } from '../library/continue-source';
import { recordedContinueSessions } from '../kernel/fake/library-continue';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Library/Personal Library',
  parameters: { layout: 'fullscreen', admitted: ['personal_library', 'reading_progress', 'collections'] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Exercise the actual page's consumer states; the current native adapter remains explicitly unavailable. */
function render(state: ContinueView) {
  setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
  return (
    <PatternStory visitor="Signed In" path="/library">
      <div className="mx-auto max-w-7xl p-4 sm:p-8">
        <PersonalLibraryPage
          page={{ signedIn: true, entries: [], next: null }}
          continueState={state}
          locale={getLocale()}
          display={{ layout: 'grid', size: 'm' }}
        />
      </div>
    </PatternStory>
  );
}

function example(state: ContinueView): Story {
  return { render: () => render(state) };
}

export const ContinueAbsent: Story = {
  ...example({ state: 'loaded', entries: [], next: null }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: m.library_heading() })).toBeVisible();
    await expect(canvas.queryByRole('heading', { level: 2, name: m.home_continue_heading() })).toBeNull();
    await expect(canvas.queryByRole('region', { name: m.home_continue_heading() })).toBeNull();
    await expect(canvas.getByRole('heading', { level: 2, name: m.library_tracked_entries() })).toBeVisible();
    await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    if (window.matchMedia('(min-width: 1024px)').matches) {
      await expect(canvas.getByRole('link', { name: m.library_continue() })).toHaveAttribute(
        'href',
        `/${getLocale()}/library/continue`,
      );
    } else {
      await userEvent.click(canvas.getByRole('button', { name: m.library_nav_selector() }));
      const role =
        window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches
          ? 'link'
          : 'menuitem';
      await expect(await within(document.body).findByRole(role, { name: m.library_continue() })).toHaveAttribute(
        'href',
        `/${getLocale()}/library/continue`,
      );
      await userEvent.keyboard('{Escape}');
    }
  },
};

export const ContinuePresent: Story = {
  render: () => {
    const session = recordedContinueSessions(getLocale())[0]!;
    return render({
      state: 'loaded',
      entries: [
        {
          subjectId: session.subjectId,
          label: session.subject.label.value,
          language: session.subject.label.language,
          summary: session.subject,
          progress: continueProgress(session),
        },
      ],
      next: null,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const session = recordedContinueSessions(getLocale())[0]!;
    await expect(await canvas.findByRole('heading', { level: 2, name: m.home_continue_heading() })).toBeVisible();
    await expect(
      await canvas.findByRole('link', { name: m.home_continue_label({ title: session.subject.label.value }) }),
    ).toHaveAttribute('href', `/${getLocale()}/library/progress/${encodeURIComponent(session.id)}`);
    await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
  },
};

function uncertain(state: ContinueView, message: () => string): Story {
  return {
    ...example(state),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await expect(await canvas.findByRole('heading', { level: 2, name: m.home_continue_heading() })).toBeVisible();
      await expect(await canvas.findByText(message(), { exact: true })).toBeVisible();
      await expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    },
  };
}

export const ContinuePreparing: Story = uncertain({ state: 'preparing', retryAfter: 30 }, () =>
  m.library_continue_preparing(),
);
export const ContinueUnknown: Story = uncertain({ state: 'unknown' }, () => m.library_continue_loading());
export const ContinueUnavailable: Story = uncertain({ state: 'unavailable', status: 503 }, () =>
  m.library_continue_unavailable(),
);
