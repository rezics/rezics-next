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
import { libraryStateLabel } from '../library/profiles';
import { shelfDisplay, shelfHref, validateShelfSearch } from '../library/shelf-params';
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
          'The real current personal Library composition in PatternStory, through the installed recorded HTTP transport. Selection and state destinations use production components. Layout specimens live under Entry layouts. Filter navigation is exercised on Pages/Library/Entries. All authored outcomes are UNRUN; these illustrative inputs establish no native or visual proof.',
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

function renderPattern(state?: string) {
  const path = shelfHref(getLocale(), { layout: 'list', size: 'm', ...(state ? { state } : {}) });
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

export const TrackedEntries: Story = {
  name: 'Owner, tracked entries',
  render: () => renderPattern(),
  play: async ({ canvasElement }) => {
    const { canvas } = await ready(canvasElement);
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
  render: () => renderPattern(filteredEntry.state),
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
