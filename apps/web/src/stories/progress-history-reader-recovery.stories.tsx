import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { profileSession } from '../kernel/fake/progress-profiles';
import { ProgressSessionPage, type ProgressDetailOrigin } from '../library/progress-session';
import type { ProgressChange, ProgressSessionPage as Page } from '../library/progress-reads';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

// UNRUN: supplied DTO presentation cases, not native read, authorization or responsive evidence.
const meta = {
  title: 'Library/Progress history reader recovery',
  id: 'pages-library-progress-history-reader-recovery',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component: 'Supplied immutable history DTOs. All interactions and visual/native verification are UNRUN.',
      },
    },
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type LoadedPage = Extract<Page, { signedIn: true }>;
const stamp = '2026-10-29T00:00:00.001Z';
const cursors = { changes: 'changes/+?q=原文#一% &==', units: 'units/+?q=原文#二% &==', logs: 'logs/+?q=原文#三% &==' };
function change(id: string, facts: Partial<ProgressChange> = {}): ProgressChange {
  return {
    id,
    revision: 2,
    createdAt: stamp,
    action: null,
    amount: null,
    locator: null,
    position: null,
    add: [],
    remove: [],
    ...facts,
  };
}
function page(facts: Partial<LoadedPage['session']> = {}): LoadedPage {
  return {
    signedIn: true,
    idempotencyKey: '10203040-5060-4070-8090-102030405060',
    session: {
      ...profileSession,
      mode: 'completed_units',
      state: 'completed',
      meaning: 'known',
      recordingState: 'unavailable',
      unitLabel: 'segments at acceptance',
      amount: null,
      total: null,
      locator: null,
      position: null,
      completedUnitCount: 0,
      changes: [],
      changesNext: null,
      units: [],
      unitsNext: null,
      ...facts,
    },
  };
}
const short = page({
  changes: [
    change('zero', { amount: '0.000000', locator: '  Part 2\n original  ', position: '0' }),
    change('duplicate-units', { add: ['same', 'first', 'same'], remove: ['last', 'last'] }),
    change('missing'),
    change('complete', { action: 'complete' }),
    change('abandon', { action: 'abandon' }),
  ],
  units: ['third', 'first', 'first'],
});
const exactText = `  <original & exact>\n${'原文📚/unbroken:'.repeat(90)}\n  `;
const long = page({
  changes: [
    change('long', {
      amount: '0',
      locator: exactText,
      position: ` position ${exactText}`,
      add: ['same', exactText, 'same', '3', '1'],
      remove: ['9', '9', exactText, '2', 'last'],
    }),
    change('separate-occurrence', { locator: exactText }),
    change('abandoned', { action: 'abandon' }),
  ],
  units: [exactText, exactText, 'short'],
});
const later = {
  ...page({ changesNext: 'next-changes/+? &==', unitsNext: 'next-units/+? &==' }),
  changesCursor: cursors.changes,
  unitsCursor: cursors.units,
};

function Reader({ data, retire = false }: { data: LoadedPage; retire?: boolean }) {
  const current = useRef(true);
  const origin = useRef<ProgressDetailOrigin>({
    viewer: 'story-owner',
    address: {
      id: data.session.id,
      ...(data.changesCursor ? { changes: data.changesCursor } : {}),
      ...(data.unitsCursor ? { units: data.unitsCursor } : {}),
      logs: cursors.logs,
    },
    isCurrent: () => current.current,
    capture: () => ({ isCurrent: () => current.current, headers: () => null }),
    refresh: async () => {
      throw new Error('Read-only history fixture must not refresh');
    },
  });
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-4">
      {retire ? (
        <button
          type="button"
          className="min-h-11 rounded border p-2"
          onClick={() => {
            current.current = false;
          }}
        >
          Retire supplied navigation authority
        </button>
      ) : null}
      <ProgressSessionPage page={data} logsCursor={cursors.logs} originating={origin.current} />
    </main>
  );
}
function render(data: LoadedPage, retire = false) {
  return (
    <PatternStory visitor="Signed In" path={`/library/progress/${data.session.id}`}>
      <Reader data={data} retire={retire} />
    </PatternStory>
  );
}
function region(canvasElement: HTMLElement, kind: 'changes' | 'units') {
  return within(canvasElement).getByRole('region', {
    name: kind === 'changes' ? m.library_progress_changes() : m.library_progress_units(),
  });
}

export const ShortZeroDuplicatesAndLifecycle: Story = {
  render: () => render(short),
  play: async ({ canvasElement }) => {
    const history = region(canvasElement, 'changes');
    expect([...history.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([
      m.library_progress_change_recorded(),
      m.library_progress_change_recorded(),
      m.library_progress_change_recorded(),
      m.library_progress_state_completed(),
      m.library_progress_state_abandoned(),
    ]);
    expect(within(history).getByText('0.000000')).toBeVisible();
    expect(within(history).getByText('0', { exact: true })).toBeVisible();
    expect(history.querySelector('summary')).toBeNull();
    expect([...region(canvasElement, 'units').querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'third',
      'first',
      'first',
    ]);
  },
};

export const LongFactsPhone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => render(long),
  play: async ({ canvasElement }) => {
    const history = region(canvasElement, 'changes');
    const rows = [...history.querySelectorAll(':scope > ol > li')];
    const summary = within(history).getByText(m.library_progress_history_reader_change_details({ number: 1 }));
    expect(rows[0]!.querySelector('[data-history-preview]')!.textContent!.length).toBeLessThan(1000);
    expect(rows[0]!.querySelector('details')!.open).toBe(false);
    summary.focus();
    await userEvent.keyboard('{Enter}');
    expect(rows[0]!.querySelector('details')!.open).toBe(true);
    expect([...rows[0]!.querySelectorAll('details dd')].map((dd) => dd.textContent)).toContain(exactText);
    expect(rows[1]!.querySelector('details')!.open).toBe(false);
    const units = region(canvasElement, 'units');
    const first = within(units).getByText(m.library_progress_history_reader_unit_details({ number: 1 }));
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect(first.closest('details')).toHaveAttribute('open');
    expect(first.nextElementSibling!.textContent).toBe(exactText);
    expect(
      within(units)
        .getByText(m.library_progress_history_reader_unit_details({ number: 2 }))
        .closest('details'),
    ).not.toHaveAttribute('open');
  },
};

export const FirstPageEmpty: Story = {
  render: () => render(page()),
  play: async ({ canvasElement }) => {
    expect(within(region(canvasElement, 'changes')).getByText(m.library_progress_changes_empty())).toBeVisible();
    expect(within(region(canvasElement, 'units')).getByText(m.library_progress_units_empty())).toBeVisible();
    expect(within(canvasElement).queryByRole('link', { name: m.library_collections_first_page() })).toBeNull();
  },
};

export const LaterEmptyIndependentRecovery: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => render(later),
  play: async ({ canvasElement }) => {
    for (const kind of ['changes', 'units'] as const) {
      const history = region(canvasElement, kind);
      const view = within(history);
      expect(
        view.getByText(
          kind === 'changes'
            ? m.library_progress_history_reader_changes_page_empty()
            : m.library_progress_history_reader_units_page_empty(),
        ),
      ).toBeVisible();
      const first = await view.findByRole('link', { name: m.library_collections_first_page() });
      const next = view.getByRole('link', { name: m.library_progress_more() });
      for (const link of [first, next]) {
        const url = new URL(link.getAttribute('href')!, window.location.href);
        const other = kind === 'changes' ? 'units' : 'changes';
        expect(url.pathname.endsWith(`/library/progress/${later.session.id}`)).toBe(true);
        expect(url.searchParams.get(other)).toBe(cursors[other]);
        expect(url.searchParams.get('logs')).toBe(cursors.logs);
        expect(url.searchParams.get(kind)).toBe(
          link === first ? null : kind === 'changes' ? later.session.changesNext : later.session.unitsNext,
        );
      }
    }
  },
};

export const SparseFirstPageWithContinuation: Story = {
  render: () => render(page({ changesNext: later.session.changesNext, unitsNext: later.session.unitsNext })),
  play: async ({ canvasElement }) => {
    for (const kind of ['changes', 'units'] as const) {
      const view = within(region(canvasElement, kind));
      expect(
        view.getByText(
          kind === 'changes'
            ? m.library_progress_history_reader_changes_page_empty()
            : m.library_progress_history_reader_units_page_empty(),
        ),
      ).toBeVisible();
      expect(await view.findByRole('link', { name: m.library_progress_more() })).toBeVisible();
      expect(view.queryByRole('link', { name: m.library_collections_first_page() })).toBeNull();
    }
  },
};

export const AbsentOperation: Story = {
  parameters: { admitted: [] },
  render: () =>
    render({ ...later, session: { ...short.session, changesNext: 'next-changes', unitsNext: 'next-units' } }),
  play: async ({ canvasElement }) => {
    const history = region(canvasElement, 'changes');
    expect(within(history).getByText('0.000000')).toBeVisible();
    expect(history.querySelector('a')).toBeNull();
    expect(region(canvasElement, 'units').querySelector('a')).toBeNull();
  },
};

export const RetiredCurrentAuthority: Story = {
  render: () => render(later, true),
  play: async ({ canvasElement }) => {
    const changes = region(canvasElement, 'changes');
    await within(changes).findByRole('link', { name: m.library_collections_first_page() });
    const links = [...changes.querySelectorAll('a'), ...region(canvasElement, 'units').querySelectorAll('a')];
    expect(links).toHaveLength(4);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Retire supplied navigation authority' }));
    for (const link of links) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  },
};
