import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { ContinueExample, continueExamples } from './library-continue/example';
import type { ContinueView } from '../library/continue-source';

const meta = {
  title: 'Patterns/Library/Continue',
  parameters: {
    layout: 'fullscreen',
    admitted: ['personal_library', 'reading_progress'],
    docs: {
      description: {
        component:
          'Supplied Continue presentations inside PatternStory plus the shared AppShell at /library/continue. ContinueExample remains the region renderer. These are contextual supplied-region examples, not the actual /library/continue PageStory or native route proof. Review the same IDs with global locale, theme, phone390 and desktop1280. Keyboard, visual and native provenance remain unmeasured.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function example(state: ContinueView, navigation = false): Story {
  return {
    render: () => (
      <PatternStory visitor="Signed In" path="/library/continue">
        <AppShell>
          <ContinueExample state={state} navigation={navigation} />
        </AppShell>
      </PatternStory>
    ),
  };
}

async function continueMain(canvasElement: HTMLElement) {
  const root = within(canvasElement);
  const main = await root.findByRole('main');
  await expect(root.getAllByRole('main')).toHaveLength(1);
  return within(main);
}

export const FractionProgress: Story = {
  ...example({ state: 'loaded', entries: continueExamples, next: null }),
  play: async ({ canvasElement }) => {
    const session = continueExamples[0]!.progress!;
    const view = await continueMain(canvasElement);
    const link = await view.findByRole('link', {
      name: m.home_continue_label({ title: continueExamples[0]!.label }),
    });
    await expect(link).toHaveAttribute(
      'href',
      `/${getLocale()}/library/progress/${encodeURIComponent(session.sessionId)}`,
    );
    await userEvent.click(
      view.getByRole('button', {
        name: m.home_continue_actions({ title: continueExamples[0]!.label }),
      }),
    );
    await expect(await within(document.body).findByText(m.home_continue_open_subject())).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
export const PositionOnlyProgress: Story = {
  ...example({
    state: 'loaded',
    entries: continueExamples.slice(0, 1).map((entry) => ({
      ...entry,
      progress: {
        sessionId: entry.progress!.sessionId,
        mode: 'cursor_position',
        unit: 'chapter',
        locator: 'Chapter 14',
        amount: null,
        total: null,
        completedUnitCount: 0,
      },
    })),
    next: null,
  }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByText('Chapter 14')).toBeVisible();
  },
};
export const NoProgress: Story = {
  ...example({
    state: 'loaded',
    entries: continueExamples.slice(0, 1).map((entry) => ({ ...entry, progress: null })),
    next: null,
  }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    const link = await view.findByRole('link', {
      name: m.home_continue_label({ title: continueExamples[0]!.label }),
    });
    await expect(link).toHaveAttribute(
      'href',
      `/${getLocale()}/library/progress?subjectId=${encodeURIComponent(continueExamples[0]!.subjectId)}`,
    );
  },
};
export const SessionOnly: Story = {
  name: 'Session without a tracked entry',
  ...example({ state: 'loaded', entries: continueExamples.slice(0, 1), next: null }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(
      await view.findByRole('link', {
        name: m.home_continue_label({ title: continueExamples[0]!.label }),
      }),
    ).toBeVisible();
  },
};
export const Empty: Story = {
  ...example({ state: 'loaded', entries: [], next: null }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByText(m.library_continue_empty())).toBeVisible();
  },
};
export const Unavailable: Story = {
  ...example({ state: 'unavailable', status: 503 }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.library_continue_unavailable());
    await userEvent.click(view.getByRole('button', { name: m.library_follow_retry() }));
    await expect(
      await view.findByRole('link', { name: m.home_continue_label({ title: continueExamples[0]!.label }) }),
    ).toBeVisible();
    await expect(view.queryByText(m.library_continue_empty())).toBeNull();
  },
};
export const Preparing: Story = {
  ...example({ state: 'preparing', retryAfter: 2 }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.library_continue_preparing());
    await expect(view.getByRole('button', { name: m.library_follow_retry() })).toBeEnabled();
    await expect(view.queryByRole('alert')).toBeNull();
    await expect(view.queryByText(m.library_continue_unavailable())).toBeNull();
  },
};
export const Loading: Story = {
  ...example({ state: 'unknown' }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.library_continue_loading());
    await expect(view.queryByRole('button', { name: m.library_follow_retry() })).toBeNull();
    await expect(view.queryByRole('alert')).toBeNull();
  },
};
export const Denied: Story = {
  ...example({ state: 'denied', status: 403 }),
  play: async ({ canvasElement }) => {
    const view = await continueMain(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.library_continue_denied());
    await expect(view.queryByRole('button', { name: m.library_follow_retry() })).toBeNull();
    await expect(view.queryByRole('alert')).toBeNull();
    await expect(view.queryByText(m.library_continue_unavailable())).toBeNull();
  },
};
export const Navigation: Story = {
  ...example({ state: 'unavailable', reason: 'missing-binding' }, true),
  play: async ({ canvasElement }) => {
    const canvas = await continueMain(canvasElement);
    await expect(canvas.queryByRole('heading', { level: 1, name: m.library_continue() })).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-library-navigation]')).toHaveLength(1);
    if (window.matchMedia('(min-width: 1024px)').matches) {
      await expect(await canvas.findByRole('link', { name: m.library_continue() })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(canvas.getByRole('link', { name: m.library_nav_tracked_entries() })).toHaveAttribute(
        'href',
        `/${getLocale()}/library`,
      );
    } else {
      await userEvent.click(
        await canvas.findByRole('button', { name: `${m.library_continue()} ${m.library_nav_selector()}` }),
      );
      await expect(await within(document.body).findByText(m.library_nav_tracked_entries())).toBeVisible();
    }
  },
};
