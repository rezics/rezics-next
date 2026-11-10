import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ContinueSection, useContinueRefresh } from '../library/continue';
import { presentContinuePage, type NativeContinuePage } from '../library/continue-adapter';
import type { ContinueResult, ContinueView } from '../library/continue-source';
import recording from '../kernel/recorded/library-continue-progress-sessions.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady, PatternStory } from './page';

const meta = {
  title: 'Library/Continue reader',
  id: 'patterns-library-continue-reader',
  parameters: {
    layout: 'fullscreen',
    admitted: ['personal_library', 'reading_progress', 'collections'],
    docs: {
      description: {
        component:
          'UNRUN authored coverage using the real ContinueSection, refresh hook and connected PatternStory providers. The local mounted FULL-shaped fixture extends recorded subjects with long supported labels, zero and a historical decimal; these are illustrative source inputs, not recorded native outcomes. Its bounded reading column intentionally overflows the cover row at both global viewports. Recovery is a held local response, not production readiness or fabricated preparation completion. Use the same stories at phone390 and desktop1280, supported locale globals, and a 320px viewport for narrow layout review. The route story preserves the current unavailable native binding.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const longTitle =
  'Eine sehr lange überlieferte Geschichte über das Lesen, die ursprüngliche Ausgabe und die unveränderte gespeicherte Leseposition · 無間隔の長い作品名📚'.repeat(
    2,
  );
const full: NativeContinuePage = {
  subjects: recording.progressSessions.map(({ subject, ...session }, index) => {
    const { mode, state } = session;
    if (mode !== 'scalar_amount' && mode !== 'cursor_position' && mode !== 'completed_units')
      throw new Error('Unknown recorded mode');
    if (state !== 'active') throw new Error('Expected active recorded session');
    return {
      subjectId: session.subjectId,
      state: null,
      lastActivityAt: session.startedAt,
      subject: index === 0 ? { ...subject, label: { value: longTitle, language: 'de' } } : subject,
      activeProgressSession: {
        ...session,
        mode,
        state,
        ...(index === 0 ? { completedUnitCount: 0 } : {}),
        ...(index === 1 ? { amount: '999999999999.123456', total: null } : {}),
      },
    };
  }),
  next: 'opaque+/next==?&cursor=unchanged',
};
const loaded = presentContinuePage(full);
type Journey = { reads: () => number; release: () => void };
let activeJourney: Journey | undefined;

function Reader({ initial, destination = false }: { initial: ContinueView; destination?: boolean }) {
  const reads = useRef(0);
  const pending = useRef<((value: ContinueResult) => void) | undefined>(undefined);
  const [read] = useState(() => () => {
    reads.current++;
    return new Promise<ContinueResult>((resolve) => {
      pending.current = resolve;
    });
  });
  const current = useContinueRefresh(initial, read, destination ? 'destination' : 'region');
  useEffect(() => {
    const journey: Journey = {
      reads: () => reads.current,
      release: () => {
        pending.current?.(loaded);
        pending.current = undefined;
      },
    };
    activeJourney = journey;
    return () => {
      if (activeJourney === journey) activeJourney = undefined;
    };
  }, []);
  return (
    <div className="mx-auto min-w-0 max-w-2xl p-4 sm:p-8">
      <ContinueSection
        state={current.result}
        locale={getLocale()}
        density="large"
        destination={destination}
        onRetry={() => void current.refresh()}
        busy={current.busy}
      />
    </div>
  );
}
function example(initial: ContinueView, destination = false): Story {
  return {
    render: () => (
      <PatternStory visitor="Signed In" path={destination ? '/library/continue' : '/library'}>
        <Reader initial={initial} destination={destination} />
      </PatternStory>
    ),
  };
}
function section(canvasElement: HTMLElement) {
  const region = canvasElement.querySelector<HTMLElement>('section[data-continue-state]');
  if (!region) throw new Error('Continue region was not mounted');
  return region;
}
async function readySection(canvasElement: HTMLElement) {
  return waitFor(() => section(canvasElement));
}
function noDocumentOverflow(canvasElement: HTMLElement) {
  const document = canvasElement.ownerDocument;
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  const region = section(canvasElement);
  expect(region.getBoundingClientRect().right).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
}
async function target(control: HTMLElement, icon = false) {
  // Establish keyboard modality before inspecting the actual :focus-visible paint.
  await userEvent.keyboard('{Tab}');
  control.focus();
  await expect(control).toHaveFocus();
  expect(control.matches(':focus-visible')).toBe(true);
  const style = getComputedStyle(control);
  expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(style.outlineStyle).not.toBe('none');
  expect(style.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
  const bounds = control.getBoundingClientRect();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  if (icon) expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  return bounds;
}
async function follow(link: HTMLAnchorElement, expected: string) {
  await expect(link).toHaveAttribute('href', expected);
  let followed: string | undefined;
  const capture = (event: MouseEvent) => {
    followed = link.getAttribute('href')!;
    event.preventDefault();
  };
  link.addEventListener('click', capture);
  try {
    await userEvent.click(link);
  } finally {
    link.removeEventListener('click', capture);
  }
  expect(followed).toBe(expected);
}
async function rowControls(canvasElement: HTMLElement) {
  const region = section(canvasElement);
  const row = region.querySelector<HTMLElement>('[data-slot="cover-row"]')!;
  const buttons = [...region.querySelectorAll('button')];
  const back = buttons.find((button) => button.getAttribute('aria-label') === m.home_continue_previous());
  const next = buttons.find((button) => button.getAttribute('aria-label') === m.home_continue_next());
  if (!back || !next) throw new Error('Actual Continue row controls were not mounted');
  expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
  await expect(back).toBeDisabled();
  await expect(back).toHaveAttribute('tabindex', '-1');
  await expect(back).toHaveAttribute('aria-hidden', 'true');
  if (window.matchMedia('(pointer: fine)').matches) {
    await waitFor(() => expect(next).toBeVisible());
    const bounds = await target(next, true);
    // Control space follows the entire cover row, including its longest labels.
    expect(bounds.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().bottom);
    await userEvent.click(next);
    await waitFor(() => expect(row.scrollLeft).toBeGreaterThan(1));
    await waitFor(() => expect(back).toBeVisible());
    const previousBounds = await target(back, true);
    expect(previousBounds.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().bottom);
    await userEvent.click(back);
    await waitFor(() => expect(row.scrollLeft).toBeLessThanOrEqual(1));
    await expect(back).toBeDisabled();
    await expect(back).toHaveAttribute('tabindex', '-1');
  } else {
    await expect(next).not.toBeVisible();
    await expect(back).not.toBeVisible();
    await expect(row).toHaveAttribute('tabindex', '0');
  }
  noDocumentOverflow(canvasElement);
}

export const RegionNavigation: Story = {
  ...example(loaded),
  play: async ({ canvasElement }) => {
    const region = await readySection(canvasElement);
    const canvas = within(region);
    await canvas.findByRole('link', { name: m.home_continue_label({ title: longTitle }) });
    const more = canvas.getByRole('link', { name: m.library_more() }) as HTMLAnchorElement;
    const bounds = await target(more);
    const heading = canvas.getByRole('heading', { level: 2, name: m.home_continue_heading() }).getBoundingClientRect();
    expect(bounds.left >= heading.right || bounds.top >= heading.bottom || heading.top >= bounds.bottom).toBe(true);
    await follow(more, `/${getLocale()}/library/continue`);
    await rowControls(canvasElement);
    expect(activeJourney?.reads()).toBe(0);
  },
};

export const DestinationNavigation: Story = {
  ...example(loaded, true),
  play: async ({ canvasElement }) => {
    const region = await readySection(canvasElement);
    const canvas = within(region);
    const first = await canvas.findByRole('link', { name: m.home_continue_label({ title: longTitle }) });
    await expect(first).toHaveAttribute(
      'href',
      `/${getLocale()}/library/progress/${full.subjects[0]!.activeProgressSession!.id}`,
    );
    const next = canvas.getByRole('link', { name: m.library_next_page() }) as HTMLAnchorElement;
    const bounds = await target(next);
    const row = region.querySelector('[data-slot="cover-row"]')!;
    expect(bounds.top).toBeGreaterThanOrEqual(row.parentElement!.getBoundingClientRect().bottom);
    await follow(next, `/${getLocale()}/library/continue?cursor=${encodeURIComponent(full.next!)}`);
    await rowControls(canvasElement);
    expect(activeJourney?.reads()).toBe(0);
  },
};

export const UnavailableRecovery: Story = {
  ...example({ state: 'unavailable', status: 503 }, true),
  play: async ({ canvasElement }) => {
    const canvas = within(await readySection(canvasElement));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent(m.library_continue_unavailable());
    const retry = canvas.getByRole('button', { name: m.library_follow_retry() });
    const bounds = await target(retry);
    expect(bounds.top).toBeGreaterThanOrEqual(alert.getBoundingClientRect().bottom + 12);
    expect(activeJourney?.reads()).toBe(0);
    noDocumentOverflow(canvasElement);
    await userEvent.click(retry);
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.library_continue_loading());
    expect(canvas.queryByRole('link')).toBeNull();
    expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    expect(activeJourney?.reads()).toBe(1);
    activeJourney!.release();
    await canvas.findByRole('link', { name: m.home_continue_label({ title: longTitle }) });
    expect(canvas.queryByRole('alert')).toBeNull();
    expect(activeJourney?.reads()).toBe(1);
    await rowControls(canvasElement);
  },
};

function notice(initial: ContinueView, message: () => string): Story {
  return {
    ...example(initial),
    play: async ({ canvasElement }) => {
      const canvas = within(await readySection(canvasElement));
      const status = await canvas.findByRole('status');
      await expect(status).toHaveTextContent(message());
      expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth + 1);
      if (initial.state === 'preparing') {
        const retry = canvas.getByRole('button', { name: m.library_follow_retry() });
        const bounds = await target(retry);
        expect(bounds.top).toBeGreaterThanOrEqual(status.getBoundingClientRect().bottom + 12);
      }
      noDocumentOverflow(canvasElement);
      expect(activeJourney?.reads()).toBe(0);
    },
  };
}
export const Loading = notice({ state: 'unknown' }, () => m.library_continue_loading());
export const Empty = notice({ state: 'loaded', entries: [], next: null }, () => m.library_continue_empty());
export const Preparing = notice({ state: 'preparing', retryAfter: 600 }, () => m.library_continue_preparing());

export const CurrentDestinationUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/continue" />,
  play: async (context) => {
    await pageReady(context);
    const region = section(context.canvasElement);
    const canvas = within(region);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_continue_unavailable());
    const retry = canvas.getByRole('button', { name: m.library_follow_retry() });
    await target(retry);
    await userEvent.click(retry);
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(m.library_continue_unavailable()));
    expect(canvas.queryByText(m.library_continue_empty())).toBeNull();
    noDocumentOverflow(context.canvasElement);
  },
};
