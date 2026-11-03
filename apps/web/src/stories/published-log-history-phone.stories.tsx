import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { longPublishedLogNote, myLogsStoryActivity, setMyLogsStory, type MyLogsScenario } from '../kernel/fake/my-logs';
import { MyLogsPageView } from '../library/my-logs-page';
import { myLogsNavigation } from '../library/my-logs';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

// UNRUN: authored connected browser coverage. Native, browser and full acceptance proof are deferred.
const meta = {
  title: 'Pages/Library/Published log history navigation',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The real history route uses the existing setMyLogsStory recording/admission protocol for Owner → later page → Newest and explicit retry. Empty/refused/restart and restart-empty outcomes are constructed consumer examples derived from the FULL recording. Restarted empty enters the guarded route with that stale cursor. Signed-out recovery is a supplemental PatternStory of MyLogsPageView when no admitted live auth transition exists; manual view props do not prove a route guard or session change. Long uses the existing native-supported 1,000-character note fixture. Review these same exports with global phone390/desktop1280 viewports, all locales, and a 320px receiving browser. Plays are authored coverage, not executed layout or native proof.',
      },
    },
  },
  beforeEach() {
    setMyLogsStory('ready');
    return () => setMyLogsStory();
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const render = () => <PageStory visitor="Signed In" path="/library/logs" />;
const scenario = (value: MyLogsScenario) => () => {
  setMyLogsStory(value);
};
const laterCursor = 'native/+?q=原文#% &==';

function article(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole('heading', { name: m.library_my_logs_heading() }).closest('article')!;
}
function fits(canvasElement: HTMLElement) {
  const page = article(canvasElement);
  const document = canvasElement.ownerDocument;
  expect(page.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth + 1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  for (const text of page.querySelectorAll('header, [role="alert"], [role="status"]')) {
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
  }
}
function target(control: HTMLElement, canvasElement: HTMLElement) {
  const bounds = control.getBoundingClientRect();
  const parent = article(canvasElement).getBoundingClientRect();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(parent.left - 1);
  expect(bounds.right).toBeLessThanOrEqual(parent.right + 1);
  expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  return bounds;
}
async function focus(control: HTMLElement) {
  control.focus();
  await userEvent.tab({ shift: true });
  await userEvent.tab();
  expect(control).toHaveFocus();
  expect(control.matches(':focus-visible')).toBe(true);
  const style = getComputedStyle(control);
  expect(style.outlineStyle).not.toBe('none');
  expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
}
function separate(first: HTMLElement, second: HTMLElement) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
}
function exactHistoryLink(link: HTMLElement, cursor: string | null) {
  expect(link.getAttribute('href')).toBe(
    `/${getLocale()}/library/logs${cursor === null ? '' : `?${new URLSearchParams({ cursor })}`}`,
  );
}

export const OwnerHistoryNavigation: Story = {
  render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list', { name: m.library_logs_heading() });
    expect(list.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
    const more = await canvas.findByRole('link', { name: m.library_logs_more() });
    exactHistoryLink(more, 'story-older-page');
    target(more, canvasElement);
    const reads = myLogsStoryActivity();
    await focus(more);
    fits(canvasElement);
    expect(myLogsStoryActivity()).toEqual(reads);
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(`${m.library_logs_session_state()}: ${m.library_progress_state_abandoned()}`);
    const newest = await canvas.findByRole('link', { name: m.library_my_logs_newest() });
    expect(canvas.getByRole('list', { name: m.library_logs_heading() }).querySelectorAll(':scope > li')).toHaveLength(
      1,
    );
    expect(canvas.queryByRole('link', { name: m.library_logs_more() })).toBeNull();
    exactHistoryLink(newest, null);
    target(newest, canvasElement);
    await focus(newest);
    fits(canvasElement);
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('link', { name: m.library_logs_more() });
    expect(canvas.queryByRole('link', { name: m.library_my_logs_newest() })).toBeNull();
    expect(canvas.getByRole('list', { name: m.library_logs_heading() }).querySelectorAll(':scope > li')).toHaveLength(
      2,
    );
    expect(myLogsStoryActivity().detailReads).toBe(0);
    fits(canvasElement);
  },
};

export const LongNotesAndNavigation: Story = {
  beforeEach: scenario('long'),
  render: () => <PageStory visitor="Signed In" path="/library/logs?cursor=earlier-page" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list', { name: m.library_logs_heading() });
    const rows = [...list.querySelectorAll(':scope > li')];
    const summary = rows[0]!.querySelector('summary')!;
    const log = within(rows[0]! as HTMLElement).getByRole('link');
    const more = canvas.getByRole('link', { name: m.library_logs_more() });
    const newest = canvas.getByRole('link', { name: m.library_my_logs_newest() });
    const activity = myLogsStoryActivity();
    const destination = log.getAttribute('href');
    exactHistoryLink(more, 'story-older-page');
    exactHistoryLink(newest, null);
    for (const control of [summary, log, more, newest]) target(control, canvasElement);
    separate(summary, log);
    separate(more, newest);
    await focus(more);
    await focus(newest);
    await focus(summary);
    await userEvent.keyboard('{Enter}');
    expect(rows[0]!.querySelector('details')).toHaveAttribute('open');
    expect(rows[1]!.querySelector('details')).not.toHaveAttribute('open');
    expect(rows[0]!.querySelector('details > p')?.textContent).toBe(longPublishedLogNote);
    expect(rows[0]!.querySelector('details > p')).toBeVisible();
    expect(rows[0]!.querySelector('details > p em')).toBeNull();
    expect(rows[0]!.querySelectorAll('a')).toHaveLength(1);
    expect(log.getAttribute('href')).toBe(destination);
    expect(myLogsStoryActivity()).toEqual(activity);
    separate(summary, log);
    fits(canvasElement);
  },
};

export const FirstPageEmpty: Story = {
  beforeEach: scenario('empty'),
  render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_logs_empty());
    expect(canvas.queryByText(m.library_my_logs_no_visible())).toBeNull();
    expect(canvas.queryByRole('link', { name: m.library_my_logs_newest() })).toBeNull();
    expect(canvas.queryByRole('link', { name: m.library_logs_more() })).toBeNull();
    fits(canvasElement);
  },
};

export const LaterEmptyRecovery: Story = {
  beforeEach: scenario('empty'),
  render: () => (
    <PageStory visitor="Signed In" path={`/library/logs?${new URLSearchParams({ cursor: laterCursor })}`} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_my_logs_no_visible());
    expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
    expect(canvas.queryByRole('list', { name: m.library_logs_heading() })).toBeNull();
    const newest = canvas.getByRole('link', { name: m.library_my_logs_newest() });
    exactHistoryLink(newest, null);
    target(newest, canvasElement);
    await focus(newest);
    fits(canvasElement);
    setMyLogsStory('ready');
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('list', { name: m.library_logs_heading() });
    expect(canvas.queryByText(m.library_my_logs_no_visible())).toBeNull();
    fits(canvasElement);
  },
};

function recovery(state: 'unavailable' | 'denied' | 'preparing'): Story {
  return {
    beforeEach: scenario(state),
    render,
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('heading', { name: m.library_my_logs_heading() });
      const view = within(article(canvasElement));
      await waitFor(() =>
        expect(view.getByRole(state === 'preparing' ? 'status' : 'alert')).toHaveTextContent(
          state === 'unavailable'
            ? m.library_my_logs_unavailable()
            : state === 'denied'
              ? m.library_my_logs_denied()
              : m.library_my_logs_preparing(),
        ),
      );
      const notice = view.getByRole(state === 'preparing' ? 'status' : 'alert');
      expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
      const retry = canvas.getByRole('button', { name: m.library_my_logs_retry() });
      target(retry, canvasElement);
      separate(notice, retry);
      const activity = myLogsStoryActivity();
      await focus(retry);
      expect(myLogsStoryActivity()).toEqual(activity);
      fits(canvasElement);
      setMyLogsStory('ready');
      await userEvent.keyboard('{Enter}');
      await canvas.findByRole('list', { name: m.library_logs_heading() });
      await waitFor(() => expect(myLogsStoryActivity().listReads).toBe(1));
      expect(canvas.queryByRole('button', { name: m.library_my_logs_retry() })).toBeNull();
      fits(canvasElement);
    },
  };
}
export const UnavailableRecovery: Story = recovery('unavailable');
export const DeniedRecovery: Story = recovery('denied');
export const PreparingRecovery: Story = recovery('preparing');

export const RestartedHistory: Story = {
  beforeEach: scenario('restart'),
  render: () => <PageStory visitor="Signed In" path="/library/logs?cursor=expired-epoch" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_my_logs_restarted());
    await canvas.findByRole('list', { name: m.library_logs_heading() });
    const newest = canvas.getByRole('link', { name: m.library_my_logs_newest() });
    exactHistoryLink(newest, null);
    target(newest, canvasElement);
    await focus(newest);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.queryByText(m.library_my_logs_restarted())).toBeNull());
    fits(canvasElement);
  },
};

export const RestartedEmpty: Story = {
  beforeEach: scenario('restart-empty'),
  render: () => <PageStory visitor="Signed In" path="/library/logs?cursor=expired-epoch" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.library_my_logs_restarted());
    expect(canvas.getByText(m.library_logs_empty())).toBeVisible();
    expect(canvas.queryByText(m.library_my_logs_no_visible())).toBeNull();
    expect(canvas.queryByRole('list', { name: m.library_logs_heading() })).toBeNull();
    expect(canvas.queryByRole('link', { name: m.library_logs_more() })).toBeNull();
    const newest = canvas.getByRole('link', { name: m.library_my_logs_newest() });
    exactHistoryLink(newest, null);
    target(newest, canvasElement);
    await focus(newest);
    expect(myLogsStoryActivity().detailReads).toBe(0);
    fits(canvasElement);
  },
};

export const SignedOutRecovery: Story = {
  name: 'Signed-out recovery (supplemental view)',
  render: () => (
    <PatternStory visitor="Signed Out" path={`/library/logs?${new URLSearchParams({ cursor: laterCursor })}`}>
      <AppShell navigation={myLogsNavigation}>
        <MyLogsPageView page={{ state: 'signed-out' }} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const signIn = await canvas.findByRole('link', { name: m.library_my_logs_sign_in() });
    expect(signIn.getAttribute('href')).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`,
    );
    target(signIn, canvasElement);
    await focus(signIn);
    expect(canvas.queryByText(m.library_logs_empty())).toBeNull();
    expect(canvas.queryByRole('button', { name: m.library_my_logs_retry() })).toBeNull();
    expect(myLogsStoryActivity().listReads).toBe(0);
    fits(canvasElement);
  },
};
