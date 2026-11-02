import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient, useSuspenseQuery, type QueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { Suspense } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Toaster } from '@rezics/ui/shadcn/toast';
import { createStoryFetch } from '../../.storybook/cloudflare-workers';
import { createRecordedKernelFetch } from '../kernel/fake';
import { setContinueStorySize } from '../kernel/fake/library-continue';
import { setLibraryEntriesStoryMode } from '../kernel/fake/library-entries-story';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import entries from '../kernel/recorded/library-entries.json';
import entriesZhHans from '../kernel/recorded/library-entries-zh-Hans.json';
import definitions from '../kernel/recorded/definitions-release.json';
import { PersonalLibraryCurrent } from '../library/personal-library-current';
import { readPersonalLibraryCurrent } from '../library/personal-library-server';
import { libraryStateLabel, libraryStateOptions } from '../library/profiles';
import {
  shelfDisplay,
  shelfHref,
  validateShelfSearch,
  type ShelfDisplay,
  type ShelfSearch,
} from '../library/shelf-params';
import { displayLibraryTitle } from '../library/title';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import type { Release } from '../subject/definitions';
import { subjectHref } from '../subject/subject-href';
import { PatternStory } from './page';

type FixtureState = 'recorded' | 'long-titles' | 'subject-unavailable';
const release = definitions.release as unknown as Release;
const filteredEntry = entries.libraryEntries.find((entry) => entry.state === 'planned')!;
const clients = new WeakMap<Element, QueryClient>();

/** Illustrative HTTP bodies retain source order, IDs, revisions and dates; only the named presentation varies. */
function illustrativeEntries(source: typeof entries, state: FixtureState) {
  return {
    ...source,
    libraryEntries: source.libraryEntries.map((entry, index) => ({
      ...entry,
      subject:
        state === 'subject-unavailable' && index === 0
          ? null
          : {
              ...entry.subject,
              label: {
                ...entry.subject.label,
                value:
                  state === 'long-titles'
                    ? Array.from({ length: 4 }, () => entry.subject.label.value).join(' — ')
                    : entry.subject.label.value,
              },
            },
    })),
  };
}

const meta = {
  title: 'Patterns/Library/Tracked entries',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The real current personal Library composition in PatternStory, through the installed recorded HTTP transport. Entry presentations exercises table, grid and list through production display controls; the table address intentionally renders the production list fallback below 640px. Grid sizes exercises small, medium and large through those same controls, with separate starting states for each size. Profile state destinations covers every state declared by the recorded Book profile with its exact subject and state links. Selection and current-owner retirement remain production behavior. Filter navigation is exercised on Pages/Library/Entries. Review these same states, including long titles, with the global phone390 and desktop1280 viewport controls. All authored outcomes are UNRUN; these illustrative inputs establish no native or visual proof.',
      },
    },
  },
  decorators: [
    (Story) => (
      <Toaster>
        <Story />
      </Toaster>
    ),
  ],
  beforeEach: ({ parameters }) => {
    setLibraryEntriesStoryMode('recorded');
    setContinueStorySize(0);
    setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
    const state: FixtureState = parameters.trackedEntriesFixture ?? 'recorded';
    const previous = globalThis.fetch;
    const transport = createStoryFetch(
      previous,
      createRecordedKernelFetch({
        'library-entries': illustrativeEntries(entries, state),
        'library-entries-zh-Hans': illustrativeEntries(entriesZhHans, state),
      }),
    );
    globalThis.fetch = transport;
    return () => {
      if (globalThis.fetch === transport) globalThis.fetch = previous;
      setContinueStorySize(6);
      setLibraryNavigationStoryState({});
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function TrackedEntriesPattern() {
  const client = useQueryClient();
  const location = useLocation();
  const search = validateShelfSearch(location.search);
  const locale = getLocale();
  const { data } = useSuspenseQuery({
    queryKey: ['story', 'tracked-entries', locale, search],
    queryFn: () => readPersonalLibraryCurrent({ data: search }),
  });
  return (
    <div
      className="w-full min-w-0 max-w-6xl p-4"
      data-tracked-entries
      ref={(node) => {
        if (node) clients.set(node, client);
      }}
    >
      <PersonalLibraryCurrent initial={data} search={search} locale={locale} display={shelfDisplay(search)} />
    </div>
  );
}

function renderPattern(input: ShelfSearch = {}) {
  const path = shelfHref(getLocale(), { layout: 'list', size: 'm', ...input });
  return (
    <PatternStory visitor="Signed In" path={path}>
      <Suspense fallback={null}>
        <TrackedEntriesPattern />
      </Suspense>
    </PatternStory>
  );
}

function sourceEntries() {
  return getLocale() === 'zh-Hans' ? entriesZhHans.libraryEntries : entries.libraryEntries;
}

async function ready(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { name: m.library_tracked_entries() });
  const select = await canvas.findByRole('button', { name: m.library_selection_page() });
  await waitFor(() => expect(select).toBeEnabled());
  return { canvas, select };
}

/** Read the visible production body: a table address has a list body on narrow screens. */
async function expectPresentation(canvasElement: HTMLElement, display: ShelfDisplay) {
  const { canvas } = await ready(canvasElement);
  const view = canvasElement.ownerDocument.defaultView!;
  const wide = view.matchMedia('(min-width: 640px)').matches;
  await waitFor(() => {
    expect(canvasElement.querySelector('input[name="layout"]')).toHaveValue(display.layout);
    expect(canvasElement.querySelector('input[name="size"]')).toHaveValue(display.size);
  });
  const layout = within(canvas.getByRole('group', { name: m.library_layout() }));
  if (display.layout === 'table' && !wide) {
    expect(layout.queryByRole('button', { name: m.library_layout_table() })).toBeNull();
    expect(canvas.queryByRole('button', { name: m.library_columns() })).toBeNull();
  } else {
    const label =
      display.layout === 'grid'
        ? m.library_layout_grid()
        : display.layout === 'list'
          ? m.library_layout_list()
          : m.library_layout_table();
    await expect(layout.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  }
  const body = within(canvasElement.querySelector('fieldset[aria-busy]')!);
  if (display.layout === 'grid') {
    const size = within(canvas.getByRole('group', { name: m.library_size() }));
    const label =
      display.size === 's'
        ? m.library_size_small()
        : display.size === 'm'
          ? m.library_size_medium()
          : m.library_size_large();
    await expect(size.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    const grid = canvasElement.querySelector('[data-slot="cover-grid"]')!;
    await expect(grid).toBeVisible();
    expect(grid.querySelectorAll('[data-slot="cover-card"]')).toHaveLength(sourceEntries().length);
    // Assert actual rendered density, rather than only the selected control or a story-owned attribute.
    const columns = view.getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat);
    if (wide) {
      const rem = Number.parseFloat(view.getComputedStyle(canvasElement.ownerDocument.documentElement).fontSize);
      for (const width of columns) expect(width).toBeCloseTo({ s: 6, m: 7.5, l: 9 }[display.size] * rem, 1);
    } else expect(columns).toHaveLength({ s: 4, m: 3, l: 2 }[display.size]);
    expect(body.queryByRole('list')).toBeNull();
    expect(body.queryByRole('table')).toBeNull();
  } else if (display.layout === 'table' && wide) {
    await expect(body.getByRole('table')).toBeVisible();
    expect(body.getAllByRole('row')).toHaveLength(sourceEntries().length + 1);
    expect(body.queryByRole('list')).toBeNull();
  } else {
    await expect(body.getByRole('list')).toBeVisible();
    expect(body.getAllByRole('listitem')).toHaveLength(sourceEntries().length);
    expect(body.queryByRole('table')).toBeNull();
  }
}

async function expectRecordedDestinations(canvasElement: HTMLElement, display: ShelfDisplay) {
  const { canvas } = await ready(canvasElement);
  const titles = sourceEntries().map((entry) => displayLibraryTitle(entry.subject.label, getLocale()).text);
  const subjectLinks = canvas.getAllByRole('link').filter((link) => titles.includes(link.textContent ?? ''));
  expect(subjectLinks.map((link) => link.textContent)).toEqual(titles);
  for (const entry of sourceEntries()) {
    const title = displayLibraryTitle(entry.subject.label, getLocale()).text;
    await expect(canvas.getByRole('link', { name: title })).toHaveAttribute(
      'href',
      subjectHref({ id: entry.subject.id, label: title }, getLocale()).href,
    );
    const status = libraryStateLabel(release, entry.subject.type, entry.state, getLocale())!.text;
    await expect(canvas.getByRole('link', { name: status })).toHaveAttribute(
      'href',
      shelfHref(getLocale(), { state: entry.state, ...display }),
    );
    await expect(canvas.getByRole('button', { name: m.library_entry_actions({ title }) })).toBeEnabled();
  }
}

export const EntryPresentations: Story = {
  name: 'Owner, entry presentations',
  render: () => renderPattern({ layout: 'table' }),
  play: async ({ canvasElement, step }) => {
    await step('Table address: actual table or production narrow-screen list fallback', async () => {
      await expectPresentation(canvasElement, { layout: 'table', size: 'm' });
      await expectRecordedDestinations(canvasElement, { layout: 'table', size: 'm' });
    });
    await step('Production grid control retains recorded entries and destinations', async () => {
      const { canvas } = await ready(canvasElement);
      await userEvent.click(canvas.getByRole('button', { name: m.library_layout_grid() }));
      await expectPresentation(canvasElement, { layout: 'grid', size: 'm' });
      await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 'm' });
    });
    await step('Production list control retains recorded entries and destinations', async () => {
      const { canvas } = await ready(canvasElement);
      await userEvent.click(canvas.getByRole('button', { name: m.library_layout_list() }));
      await expectPresentation(canvasElement, { layout: 'list', size: 'm' });
      await expectRecordedDestinations(canvasElement, { layout: 'list', size: 'm' });
    });
  },
};

export const SmallEntryGrid: Story = {
  name: 'Owner, small entry grid',
  render: () => renderPattern({ layout: 'grid', size: 's' }),
  play: async ({ canvasElement }) => {
    await expectPresentation(canvasElement, { layout: 'grid', size: 's' });
    await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 's' });
  },
};

export const MediumEntryGrid: Story = {
  name: 'Owner, medium entry grid',
  render: () => renderPattern({ layout: 'grid', size: 'm' }),
  play: async ({ canvasElement }) => {
    await expectPresentation(canvasElement, { layout: 'grid', size: 'm' });
    await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 'm' });
  },
};

export const LargeEntryGrid: Story = {
  name: 'Owner, large entry grid',
  render: () => renderPattern({ layout: 'grid', size: 'l' }),
  play: async ({ canvasElement }) => {
    await expectPresentation(canvasElement, { layout: 'grid', size: 'l' });
    await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 'l' });
  },
};

export const EntryGridSizes: Story = {
  name: 'Owner, entry grid sizes',
  render: () => renderPattern({ layout: 'grid', size: 's' }),
  play: async ({ canvasElement, step }) => {
    await step('Small grid has the production small density', async () => {
      await expectPresentation(canvasElement, { layout: 'grid', size: 's' });
      await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 's' });
    });
    for (const size of ['m', 'l'] as const) {
      await step(`Production size control selects ${size}`, async () => {
        const { canvas } = await ready(canvasElement);
        const label = size === 'm' ? m.library_size_medium() : m.library_size_large();
        await userEvent.click(canvas.getByRole('button', { name: label }));
        await expectPresentation(canvasElement, { layout: 'grid', size });
        await expectRecordedDestinations(canvasElement, { layout: 'grid', size });
      });
    }
  },
};

export const ProfileStateDestinations: Story = {
  name: 'Owner, profile state destinations',
  render: () => renderPattern({ layout: 'grid' }),
  play: async ({ canvasElement }) => {
    await expectPresentation(canvasElement, { layout: 'grid', size: 'm' });
    for (const type of new Set(sourceEntries().map((entry) => entry.subject.type))) {
      const recordedStates = sourceEntries()
        .filter((entry) => entry.subject.type === type)
        .map((entry) => entry.state);
      const profileStates = libraryStateOptions(release, type, getLocale()).map((option) => option.id);
      expect([...new Set(recordedStates)].sort()).toEqual(profileStates.sort());
    }
    await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 'm' });
  },
};

export const TrackedEntries: Story = {
  name: 'Owner, tracked entries',
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas } = await ready(canvasElement);
    const titles = sourceEntries().map((entry) => displayLibraryTitle(entry.subject.label, getLocale()).text);
    const subjectLinks = canvas.getAllByRole('link').filter((link) => titles.includes(link.textContent ?? ''));
    expect(subjectLinks.map((link) => link.textContent)).toEqual(titles);
    for (const entry of sourceEntries()) {
      const title = displayLibraryTitle(entry.subject.label, getLocale()).text;
      await expect(canvas.getByRole('link', { name: title })).toHaveAttribute(
        'href',
        subjectHref({ id: entry.subject.id, label: title }, getLocale()).href,
      );
      const status = libraryStateLabel(release, entry.subject.type, entry.state, getLocale())!.text;
      await expect(canvas.getByRole('link', { name: status })).toHaveAttribute(
        'href',
        shelfHref(getLocale(), { state: entry.state, layout: 'list', size: 'm' }),
      );
    }
  },
};

export const StateFilterActive: Story = {
  name: 'Owner, state filter active',
  render: () => renderPattern({ state: filteredEntry.state }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = libraryStateLabel(release, filteredEntry.subject.type, filteredEntry.state, getLocale())!.text;
    await canvas.findByRole('heading', { name: m.library_tracked_entries_state({ status }) });
    await expect(canvas.getByRole('link', { name: m.library_clear_state() })).toHaveAttribute(
      'href',
      shelfHref(getLocale(), { layout: 'list', size: 'm' }),
    );
    for (const entry of sourceEntries()) {
      const title = displayLibraryTitle(entry.subject.label, getLocale()).text;
      if (entry.state === filteredEntry.state) await expect(canvas.getByRole('link', { name: title })).toBeVisible();
      else expect(canvas.queryByRole('link', { name: title })).toBeNull();
    }
  },
};

export const SelectionMode: Story = {
  name: 'Owner, one tracked entry selected',
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas, select } = await ready(canvasElement);
    await userEvent.click(select);
    for (const entry of sourceEntries().slice(1)) {
      const title = displayLibraryTitle(entry.subject.label, getLocale()).text;
      await userEvent.click(canvas.getByRole('checkbox', { name: title }));
    }
    const first = displayLibraryTitle(sourceEntries()[0]!.subject.label, getLocale()).text;
    await expect(canvas.getByRole('checkbox', { name: first })).toBeChecked();
    const selection = within(canvas.getByRole('region', { name: m.library_selection_heading() }));
    await expect(selection.getByRole('status')).toHaveTextContent(m.library_selection_count({ count: 1 }));
    await userEvent.click(selection.getByRole('button', { name: m.library_selection_clear() }));
    expect(canvas.queryByRole('region', { name: m.library_selection_heading() })).toBeNull();
  },
};

export const LongTitles: Story = {
  name: 'Owner, long tracked titles',
  parameters: { trackedEntriesFixture: 'long-titles' },
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas } = await ready(canvasElement);
    for (const entry of sourceEntries()) {
      const title = Array.from({ length: 4 }, () => entry.subject.label.value).join(' — ');
      await expect(canvas.getByRole('link', { name: title })).toBeVisible();
      await expect(canvas.getByRole('button', { name: m.library_entry_actions({ title }) })).toBeEnabled();
    }
  },
};

export const SubjectUnavailable: Story = {
  name: 'Owner, tracked subject unavailable',
  parameters: { trackedEntriesFixture: 'subject-unavailable' },
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas, select } = await ready(canvasElement);
    await canvas.findByText(m.library_subject_unavailable());
    const title = displayLibraryTitle(sourceEntries()[0]!.subject.label, getLocale()).text;
    expect(canvas.queryByRole('link', { name: title })).toBeNull();
    await userEvent.click(select);
    expect(canvas.queryByRole('checkbox', { name: m.library_subject_unavailable() })).toBeNull();
    const selection = within(canvas.getByRole('region', { name: m.library_selection_heading() }));
    await expect(selection.getByRole('status')).toHaveTextContent(
      m.library_selection_count({ count: sourceEntries().length - 1 }),
    );
  },
};

export const ViewerRetired: Story = {
  name: 'Owner selection retired after sign out',
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas, select } = await ready(canvasElement);
    await userEvent.click(select);
    await expect(canvas.getByRole('region', { name: m.library_selection_heading() })).toBeVisible();
    const region = canvasElement.querySelector('[data-tracked-entries]')!;
    const client = clients.get(region)!;
    // Retire the actual session observation; no story-owned selection or authorization controls intervene.
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    await waitFor(() => {
      expect(canvas.queryByRole('region', { name: m.library_selection_heading() })).toBeNull();
      expect(canvas.queryByRole('checkbox')).toBeNull();
      for (const entry of sourceEntries()) {
        const title = displayLibraryTitle(entry.subject.label, getLocale()).text;
        expect(canvas.queryByRole('link', { name: title })).toBeNull();
      }
    });
  },
};
