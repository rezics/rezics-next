import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLocation } from '@tanstack/react-router';
import { shelfDisplay, validateShelfSearch } from '../library/shelf-params';
import { Toaster } from '@rezics/ui/shadcn/toast';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { PersonalLibraryEntry, PersonalLibraryView } from '../library/entries-read';
import { PersonalLibraryPage } from '../library/entries-page';
import { continueProgress } from '../library/continue-read';
import type { ContinueView } from '../library/continue-source';
import { recordedContinueSessions } from '../kernel/fake/library-continue';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';
import recordedDefinitions from '../kernel/recorded/definitions-release.json';
import { libraryStateOptions } from '../library/profiles';
import type { Release } from '../subject/definitions';
import { setLibraryEntriesStoryMode } from '../kernel/fake/library-entries-story';

const meta = {
  decorators: [
    (Story) => (
      <Toaster>
        <Story />
      </Toaster>
    ),
  ],
  title: 'Patterns/Library/Personal Library',
  beforeEach: () => setLibraryEntriesStoryMode('recorded'),
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
      await userEvent.click(
        canvas.getByRole('button', { name: `${m.library_nav_tracked_entries()} ${m.library_nav_selector()}` }),
      );
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

export const TypePickerSecondPage: Story = {
  name: 'Type chooser, another bounded page',
  ...example({ state: 'loaded', entries: [], next: null }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const action = await canvas.findByRole('button', { name: m.library_type_action({ type: m.library_types_all() }) });
    await waitFor(() => expect(action).toBeEnabled());
    await userEvent.click(action);
    const dialog = within(await within(document.body).findByRole('dialog', { name: m.library_types_heading() }));
    await userEvent.click(await dialog.findByRole('button', { name: m.library_types_next() }));
    await expect(await dialog.findByRole('button', { name: m.library_types_first() })).toBeVisible();
    await expect(dialog.queryByRole('button', { name: m.library_types_next() })).toBeNull();
    await expect(dialog.getByRole('link', { name: m.library_types_all() })).toBeVisible();
  },
};

function ChronologicalPage({ page }: { page: PersonalLibraryView }) {
  const location = useLocation();
  return (
    <PersonalLibraryPage
      page={page}
      continueState={{ state: 'loaded', entries: [], next: null }}
      locale={getLocale()}
      display={shelfDisplay(validateShelfSearch(location.search))}
    />
  );
}

function chronological(
  page: PersonalLibraryView,
  path = '/library?orderBy=finishedAt&direction=asc&layout=table',
): Story {
  return {
    render: () => {
      setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
      return (
        <PatternStory visitor="Signed In" path={path}>
          <div className="mx-auto max-w-7xl p-4 sm:p-8">
            <ChronologicalPage page={page} />
          </div>
        </PatternStory>
      );
    },
  };
}

export const ChronologicalOrder: Story = {
  ...chronological({
    signedIn: true,
    sort: { orderBy: 'finishedAt', direction: 'asc' },
    sortExplicit: true,
    entries: [
      {
        subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000011',
        state: 'reading.arc-1',
        stateLabel: 'Reading',
        revision: 1,
        incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000012',
        createdAt: '2026-01-01T00:00:00.123456Z',
        updatedAt: '2026-01-02T00:00:00.123456Z',
        lastActivityAt: '2026-01-03T00:00:00.123456Z',
        finishedAt: null,
        subject: null,
        changeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000031',
        removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000032',
      },
      {
        subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000021',
        state: 'completed',
        stateLabel: 'Completed',
        revision: 2,
        createdAt: '2026-01-01T00:00:00.123456Z',
        updatedAt: '2026-01-02T00:00:00.123456Z',
        lastActivityAt: '2026-01-04T00:00:00.123456Z',
        finishedAt: '2026-01-02T00:00:00.123456Z',
        subject: {
          id: '0192f3a0-6c1e-7b2a-9d4e-000000000021',
          type: 'schema:Book',
          types: ['schema:Book'],
          label: { value: 'A completed book', language: 'en' },
          cover: null,
        },
        changeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000033',
        removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000034',
      },
    ],
    next: 'constructed-next-page',
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('combobox', { name: m.library_sort_by() })).toHaveValue('finishedAt');
    await expect(canvas.getByRole('combobox', { name: m.library_sort_direction() })).toHaveValue('asc');
    await expect(canvas.getByRole('link', { name: m.library_next_page() })).toHaveAttribute(
      'href',
      `/${getLocale()}/library?orderBy=finishedAt&direction=asc&layout=table&cursor=constructed-next-page`,
    );
    // Unsupported columns are plain headings; the three native dates carry the only sort buttons.
    if (window.matchMedia('(min-width: 640px)').matches) {
      await expect(
        canvas.getByRole('columnheader', { name: m.library_column_title() }).querySelector('button'),
      ).toBeNull();
      await expect(canvas.getByRole('columnheader', { name: m.library_sort_finished() })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    }
  },
};

export const ChronologicalPreparing: Story = chronological({
  signedIn: true,
  entries: [],
  next: null,
  readState: 'preparing',
  sort: { orderBy: 'finishedAt', direction: 'asc' },
});
export const ChronologicalDenied: Story = chronological({
  signedIn: true,
  entries: [],
  next: null,
  readState: 'denied',
  sort: { orderBy: 'finishedAt', direction: 'asc' },
});
export const ChronologicalUnavailable: Story = chronological({
  signedIn: true,
  entries: [],
  next: null,
  readState: 'unavailable',
  sort: { orderBy: 'finishedAt', direction: 'asc' },
});

// Constructed HTTP outcomes exercise the ordinary action adapter; they are not native proof recordings.
const selectionId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(6000 + n).padStart(12, '0')}`;
function selectionEntries(): PersonalLibraryEntry[] {
  const options = libraryStateOptions(recordedDefinitions.release as unknown as Release, 'schema:Book', getLocale());
  return [1, 2, 3, 4].map((n) => ({
    subjectId: selectionId(n),
    state: options[n === 4 ? 1 : 0]!.id,
    stateLabel: options[n === 4 ? 1 : 0]!.label.text,
    stateOptions: options,
    revision: 2,
    incarnationId: selectionId(100 + n),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    subject: {
      id: selectionId(n),
      type: 'schema:Book',
      types: ['schema:Book'],
      label: {
        value: ['A new reading state', 'A concurrent change', 'A lost response', 'Already in this state'][n - 1]!,
        language: 'en',
      },
      cover: null,
    },
    changeKey: crypto.randomUUID(),
    removeKey: crypto.randomUUID(),
  }));
}
function selectionExample(incompatible = false): Story {
  return {
    render: () => {
      const entries = selectionEntries();
      if (incompatible)
        entries[1] = {
          ...entries[1]!,
          stateOptions: [{ ...entries[0]!.stateOptions![0]!, label: { text: 'A different meaning', lang: 'en' } }],
        };
      setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
      return (
        <PatternStory visitor="Signed In" path="/library">
          <div className="mx-auto max-w-7xl p-4 sm:p-8">
            <PersonalLibraryPage
              page={{ signedIn: true, entries, next: null }}
              continueState={{ state: 'loaded', entries: [], next: null }}
              locale={getLocale()}
              display={{ layout: 'grid', size: 'm' }}
            />
          </div>
        </PatternStory>
      );
    },
  };
}
function partialResponses(stopOnSecond = false) {
  const original = globalThis.fetch;
  const entries = selectionEntries();
  let unknown = true;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const entry = entries.find((row) => url.pathname === `/v1/libraryEntries/${row.subjectId}`);
    if (!entry) return original(input, init);
    if (request.method === 'GET')
      return Response.json({ libraryEntry: { ...entry, state: entry.stateOptions![2]!.id, revision: 9 } });
    if (request.method !== 'PUT') return original(input, init);
    if (entry.subjectId === selectionId(2))
      return stopOnSecond
        ? Response.json({ code: 'platform_closed' }, { status: 403 })
        : Response.json({ code: 'conflict' }, { status: 409 });
    if (entry.subjectId === selectionId(3) && unknown) {
      unknown = false;
      throw new TypeError('Constructed lost response');
    }
    const data = (await request.json()) as { state: string; revision: number; incarnationId: string };
    return Response.json({
      libraryEntry: {
        subjectId: entry.subjectId,
        ...data,
        revision: data.revision + 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
async function applySelection({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const select = await canvas.findByRole('button', { name: m.library_selection_page() });
  await waitFor(() => expect(select).toBeEnabled());
  await userEvent.click(select);
  const options = libraryStateOptions(recordedDefinitions.release as unknown as Release, 'schema:Book', getLocale());
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.library_selection_state() }), options[1]!.id);
  await userEvent.click(canvas.getByRole('button', { name: m.library_selection_apply() }));
  await waitFor(() => expect(canvasElement.querySelectorAll('[data-selection-outcome="unknown"]')).toHaveLength(1));
  await expect(canvasElement.querySelectorAll('[data-selection-outcome="changed"]')).toHaveLength(1);
  await expect(canvasElement.querySelectorAll('[data-selection-outcome="conflicted"]')).toHaveLength(1);
  await expect(canvasElement.querySelectorAll('[data-selection-outcome="unchanged"]')).toHaveLength(1);
}
export const SelectedPartialOutcomes: Story = {
  ...selectionExample(),
  name: 'Selected entries, partial outcomes',
  beforeEach: () => partialResponses(),
  play: applySelection,
};
export const SelectedUnknownRecovered: Story = {
  ...selectionExample(),
  name: 'Selected entries, unknown change recovered',
  beforeEach: () => partialResponses(),
  play: async (context) => {
    await applySelection(context);
    const canvas = within(context.canvasElement);
    const retry = await canvas.findByRole('button', {
      name: m.library_selection_retry_title({ title: 'A lost response' }),
    });
    await userEvent.click(retry);
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-selection-outcome="unknown"]')).toHaveLength(0),
    );
    await expect(context.canvasElement.querySelectorAll('[data-selection-outcome="changed"]')).toHaveLength(2);
  },
};
export const SelectedNoCommonState: Story = {
  ...selectionExample(true),
  name: 'Selected entries, no common state',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByRole('button', { name: m.library_selection_page() });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.click(select);
    await expect(await canvas.findByText(m.library_selection_no_common())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_selection_apply() })).toBeNull();
  },
};

export const SelectedAuthorityLost: Story = {
  ...selectionExample(),
  name: 'Selected entries, stopped after access closes',
  beforeEach: () => partialResponses(true),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = await canvas.findByRole('button', { name: m.library_selection_page() });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.click(select);
    const options = libraryStateOptions(recordedDefinitions.release as unknown as Release, 'schema:Book', getLocale());
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.library_selection_state() }), options[1]!.id);
    await userEvent.click(canvas.getByRole('button', { name: m.library_selection_apply() }));
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-selection-outcome="failed"]')).toHaveLength(1));
    await expect(canvasElement.querySelectorAll('[data-selection-outcome="changed"]')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-selection-outcome="not-attempted"]')).toHaveLength(2);
  },
};

export const ChosenColumns: Story = {
  ...chronological(
    { signedIn: true, entries: selectionEntries(), next: null },
    '/library?layout=table&columns=title,status',
  ),
  name: 'Chosen table columns retained',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    if (!window.matchMedia('(min-width: 640px)').matches) {
      await expect(await canvas.findByRole('link', { name: 'A new reading state' })).toBeVisible();
      await expect(canvas.queryByRole('button', { name: m.library_columns() })).toBeNull();
      return;
    }
    await expect(await canvas.findByRole('columnheader', { name: m.library_column_status() })).toBeVisible();
    await expect(canvas.queryByRole('columnheader', { name: m.library_sort_activity() })).toBeNull();
    await userEvent.click(await canvas.findByRole('button', { name: m.library_columns() }));
    const picker = within(await within(document.body).findByRole('dialog', { name: m.library_columns() }));
    await expect(picker.getByRole('checkbox', { name: m.library_column_title() })).toBeDisabled();
    await userEvent.click(picker.getByRole('checkbox', { name: m.library_column_cover() }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: m.library_layout_list() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_layout_table() }));
    await expect(await canvas.findByRole('columnheader', { name: m.library_column_cover() })).toBeVisible();
    await expect(canvas.queryByRole('columnheader', { name: m.library_sort_activity() })).toBeNull();
    await expect(
      canvas.getByRole('button', { name: m.library_entry_actions({ title: 'A new reading state' }) }),
    ).toBeEnabled();
  },
};

function selectedLabelResponses() {
  const original = globalThis.fetch;
  let unknown = true;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST' || !/^\/v1\/libraryLabels\/[^/]+:assign$/.test(new URL(request.url).pathname))
      return original(input, init);
    const body = (await request.json()) as { subjectId: string };
    if (body.subjectId === selectionId(2) && unknown) {
      unknown = false;
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    }
    return Response.json({ assignment: { id: selectionId(200 + Number(body.subjectId.slice(-1))), revision: 1 } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function applySelectedLabel({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const select = await canvas.findByRole('button', { name: m.library_selection_page() });
  await waitFor(() => expect(select).toBeEnabled());
  await userEvent.click(select);
  await userEvent.click(canvas.getByRole('button', { name: m.library_selected_labels_open() }));
  const dialog = within(await within(document.body).findByRole('dialog', { name: m.library_selected_labels_open() }));
  await userEvent.type(dialog.getByRole('textbox', { name: m.library_selected_labels_search() }), 'Read');
  await userEvent.click(await dialog.findByRole('checkbox', { name: 'Reading list' }));
  await expect(dialog.getByText(m.library_selected_labels_confirm({ name: 'Reading list', count: 4 }))).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: m.library_selected_labels_apply() }));
  await waitFor(() => expect(canvasElement.querySelectorAll('[data-label-outcome="unknown"]')).toHaveLength(1));
  await expect(canvasElement.querySelectorAll('[data-label-outcome="assigned"]')).toHaveLength(1);
  await expect(canvasElement.querySelectorAll('[data-label-outcome="not-attempted"]')).toHaveLength(2);
}

export const SelectedLabelPartialOutcomes: Story = {
  ...selectionExample(),
  name: 'Selected entries, label assignment partly unknown',
  parameters: {
    admitted: ['personal_library', 'reading_progress', 'collections', 'library_label.list', 'library_label.assign'],
  },
  beforeEach: selectedLabelResponses,
  play: applySelectedLabel,
};

export const SelectedLabelUnknownRecovered: Story = {
  ...selectionExample(),
  name: 'Selected entries, exact label assignment recovered',
  parameters: {
    admitted: ['personal_library', 'reading_progress', 'collections', 'library_label.list', 'library_label.assign'],
  },
  beforeEach: selectedLabelResponses,
  play: async (context) => {
    await applySelectedLabel(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(
      canvas.getByRole('button', {
        name: m.library_selected_labels_retry_title({
          title: 'A concurrent change',
          name: 'Reading list',
        }),
      }),
    );
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-label-outcome="unknown"]')).toHaveLength(0),
    );
    await expect(context.canvasElement.querySelectorAll('[data-label-outcome="assigned"]')).toHaveLength(2);
    await expect(context.canvasElement.querySelectorAll('[data-label-outcome="not-attempted"]')).toHaveLength(2);
  },
};
