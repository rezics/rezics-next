import type { Meta, StoryObj } from '@storybook/react-vite';
import { act, useState } from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { coverSrc, coverSummary } from '../stories/media-fixtures.ts';
import { withSurface } from '../stories/support.tsx';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from './entity-picker.tsx';
import { metaText } from './meta-line.tsx';

const subject = (id: string, title: string, typeLabel: string, year: number | undefined, cover = true) =>
  ({
    id,
    title,
    types: ['creative-work'],
    typeLabel,
    year,
    cover: cover ? coverSummary(`cover-${id}`, { width: 800, height: 1200 }) : null,
  }) satisfies EntityPickerSubject;

const catalogue: EntityPickerSubject[] = [
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa01', 'The Three-Body Problem', 'Novel', 2008),
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa02', '三体', '小说', 2008),
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa03', 'Three Days of Happiness', 'Light novel', 2017),
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa04', 'Thursday Next', 'Novel', 2001),
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa05', 'Three-Body', 'Anime series', 2023),
  subject('urn:rezics:0192f3a1-7c1e-7b52-9d34-aa06', '銀河英雄伝説', 'アニメ', 1988),
];

const odd: EntityPickerSubject[] = [
  subject(
    'long-cjk',
    '《银河英雄传说：新月之梦》——关于自由行星同盟与银河帝国之间漫长战争的叙事诗集与未发表手稿合订本',
    '小说',
    2019,
  ),
  subject(
    'long-latin',
    'Supercalifragilisticexpialidocious-Adventures-of-an-Extraordinarily-Long-Unbroken-Title',
    'Novel',
    undefined,
  ),
  subject('bare', 'Untitled', '', undefined, false),
  subject('no-cover', '無題の物語', 'Visual novel', 2011, false),
];

interface FakeSearch {
  delay?: number;
  /** While `value` is true every search fails, as with no connection. */
  offline?: { value: boolean };
  spy?: ReturnType<typeof fn>;
  pool?: EntityPickerSubject[];
}

/** A search over the catalogue that honours its signal, as a fetch does. */
const fakeSearch =
  ({ delay = 0, offline, spy, pool = catalogue }: FakeSearch = {}): EntityPickerSearch =>
  (text, signal) => {
    spy?.(text, signal);
    if (offline?.value) return Promise.reject(new Error('offline'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(pool.filter((entry) => entry.title.toLowerCase().includes(text.toLowerCase()))),
        delay,
      );
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  };

const meta = {
  title: 'Components/Entity picker',
  component: EntityPicker,
  tags: ['autodocs'],
  args: { label: 'Subject', placeholder: 'Search the catalogue', src: coverSrc, search: fakeSearch(), debounce: 40 },
  parameters: {
    docs: {
      description: {
        component:
          'A subject picker on the shadcn combobox. It asks the site’s `search(text, signal)` as the person types, after a pause, and aborts a search a newer keystroke makes stale. Each result shows its cover, title, type and year, and the subject’s id is only passed back to the site. Several subjects can be picked when asked.',
      },
    },
  },
  decorators: [
    withSurface,
    (Story) => (
      <div className="min-h-[34rem] max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EntityPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

// Use the shared phone (390px), desktop (1280px), theme and locale globals for every state.
export const Empty: Story = {
  args: { placeholder: '' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Subject' })).toHaveValue('');
  },
};

export const Selected: Story = {
  args: { multiple: true, defaultValue: odd.slice(0, 2) },
  async play({ canvasElement }) {
    const list = within(canvasElement).getByRole('list', { name: 'Selected' });
    await expect(within(list).getAllByRole('button')).toHaveLength(2);
    await expect(list).toHaveTextContent(odd[0]!.title);
    await expect(list).toHaveTextContent(odd[1]!.title);
  },
};

export const SlowSearch: Story = {
  args: { multiple: true, defaultValue: odd.slice(0, 1), search: fakeSearch({ delay: 60_000, pool: odd }) },
  async play({ canvasElement }) {
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Subject' }), 'long title');
    await expect(await screen.findByText('Searching…')).toBeVisible();
    await expect(within(canvasElement).getByRole('list', { name: 'Selected' })).toHaveTextContent(odd[0]!.title);
  },
};

const options = () => screen.findAllByRole('option');
const enabled = async (name: RegExp | string) => {
  const option = await screen.findByRole('option', { name });
  await waitFor(() => expect(option).not.toHaveAttribute('aria-disabled', 'true'));
  return option;
};

const typed = fn();
const highlightedIndex = () =>
  screen.queryAllByRole('option').findIndex((option) => option.hasAttribute('data-highlighted'));

/** Moves the highlight to the named option with the arrow key. */
const highlight = async (name: RegExp | string) => {
  // Choosing a subject closes the list; the arrow key opens it again.
  const input = screen.getByRole('combobox');
  if (input.getAttribute('aria-expanded') !== 'true') {
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'true'));
  }
  const target = await enabled(name);
  const want = screen.getAllByRole('option').indexOf(target);
  // A list that is still opening drops keys, so press again until the highlight arrives.
  await waitFor(async () => {
    if (highlightedIndex() === want) return;
    await userEvent.keyboard('{ArrowDown}');
    throw new Error(`The highlight is on option ${highlightedIndex()}, not ${want}`);
  });
};

/** Highlights the option, presses Enter, and waits for the list to close, which a choice always does. */
const choose = async (name: RegExp | string) => {
  await highlight(name);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false'));
};

export const SearchAsYouType: Story = {
  args: { search: fakeSearch({ spy: typed }), debounce: 600 },
  async play({ canvasElement }) {
    typed.mockClear();
    const input = within(canvasElement).getByRole('combobox', { name: 'Subject' });
    await userEvent.type(input, 'three');
    const option = await enabled(/The Three-Body Problem/);
    // One search for the finished word, not one per keystroke.
    await expect(typed).toHaveBeenCalledTimes(1);
    await expect(typed.mock.calls[0]![0]).toBe('three');
    await expect(option).toHaveTextContent(metaText(['Novel', '2008']));
    await expect(option.querySelector('picture img')).not.toBeNull();
    await expect(await options()).toHaveLength(3);
    await expect(screen.queryByRole('option', { name: /Thursday/ })).toBeNull();
  },
};

const stale = fn();
export const StaleSearchIsCancelled: Story = {
  args: { search: fakeSearch({ spy: stale, delay: 1500 }), debounce: 20 },
  async play({ canvasElement }) {
    stale.mockClear();
    const input = within(canvasElement).getByRole('combobox', { name: 'Subject' });
    await userEvent.type(input, 'th');
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    const first = stale.mock.calls[0]![1] as AbortSignal;
    await expect(first.aborted).toBe(false);
    await userEvent.type(input, 'ree');
    await waitFor(() => expect(first.aborted).toBe(true));
    // Only the newer search answers: “th” alone would also have found Thursday Next.
    await enabled(/The Three-Body Problem/);
    await expect(screen.queryByRole('option', { name: /Thursday/ })).toBeNull();
    await expect(stale.mock.calls.at(-1)![0]).toBe('three');
  },
};

export const SelectWithKeyboard: Story = {
  args: { onValueChange: fn() },
  async play({ canvasElement, args }) {
    const input = within(canvasElement).getByRole('combobox', { name: 'Subject' });
    await userEvent.type(input, 'three');
    await choose(/Three Days of Happiness/);
    await waitFor(() => expect(args.onValueChange).toHaveBeenCalledTimes(1));
    await expect(args.onValueChange).toHaveBeenCalledWith([
      expect.objectContaining({ title: 'Three Days of Happiness' }),
    ]);
    await waitFor(() => expect(input).toHaveValue('Three Days of Happiness'));
    // Picking a subject writes its title into the box without starting another search.
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
  },
};

export const SelectSeveral: Story = {
  args: { multiple: true, onValueChange: fn() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('combobox', { name: 'Subject' });
    await userEvent.type(input, 'three');
    await choose(/The Three-Body Problem/);
    const list = await canvas.findByRole('list', { name: 'Selected' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    await choose(/Three Days of Happiness/);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    await expect(list).toHaveTextContent('The Three-Body Problem');
    await expect(list).toHaveTextContent('Three Days of Happiness');
    await expect(list.querySelectorAll('picture img')).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove The Three-Body Problem' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    await expect(args.onValueChange).toHaveBeenLastCalledWith([expect.objectContaining({ typeLabel: 'Light novel' })]);
  },
};

export const NothingMatches: Story = {
  async play({ canvasElement }) {
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Subject' }), 'zzzz');
    const status = await screen.findByText('Nothing matches “zzzz”.');
    await waitFor(() => expect(status).toBeVisible());
    await expect(screen.queryByRole('option')).toBeNull();
    // An empty result is a sentence, not a spinner that never ends.
    await expect(screen.queryByText('Searching…')).toBeNull();
  },
};

const offline = { value: true };
export const SearchFailed: Story = {
  args: { search: fakeSearch({ offline }), multiple: true, defaultValue: odd.slice(0, 1) },
  async play({ canvasElement }) {
    offline.value = true;
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Subject' }), 'three');
    const failure = await screen.findByText('The search failed.');
    await waitFor(() => expect(failure).toBeVisible());
    await expect(screen.queryByText(/offline/)).toBeNull();
    offline.value = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await enabled(/The Three-Body Problem/);
    await expect(screen.queryByText('The search failed.')).toBeNull();
  },
};

export const NeverShowsAnId: Story = {
  args: { multiple: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('combobox', { name: 'Subject' }), 'three');
    await choose(/The Three-Body Problem/);
    await canvas.findByRole('list', { name: 'Selected' });
    const visible = [document.body.textContent ?? '']
      .concat(
        [...document.querySelectorAll('[aria-label], [title], [placeholder]')].flatMap((element) =>
          ['aria-label', 'title', 'placeholder'].map((name) => element.getAttribute(name) ?? ''),
        ),
      )
      .join('\n');
    for (const entry of catalogue) await expect(visible).not.toContain(entry.id);
    await expect(visible).not.toContain('0192f3a1');
  },
};

export const LongTitlesAndMissingData: Story = {
  args: { search: async () => odd, multiple: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('combobox', { name: 'Subject' }), 'a');
    const rows = await screen.findAllByRole('option');
    await waitFor(() => expect(rows).toHaveLength(4));
    for (const row of rows) {
      await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    }
    // The shared Cover contract uses its image icon at xs; only the title and metadata remain visible beside it.
    const untitled = screen.getByRole('option', { name: /Untitled/ });
    await expect(untitled).toHaveTextContent('Untitled');
    await expect(untitled.querySelector('[data-slot="cover-placeholder-icon"]')).not.toBeNull();
    await expect(screen.getByRole('option', { name: /無題の物語/ })).toHaveTextContent(
      metaText(['Visual novel', '2011']),
    );
  },
};

export const PhoneWidth: Story = {
  globals: {},
  args: { multiple: true },
  async play({ canvasElement }) {
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Subject' }), 'three');
    await choose(/The Three-Body Problem/);
    const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!;
    await expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(within(canvasElement).getByRole('list', { name: 'Selected' })).toBeVisible();
  },
};

interface DeferredSearch {
  query: string;
  signal: AbortSignal;
  resolve?: (items: readonly EntityPickerSubject[]) => void;
  reject?: (reason: unknown) => void;
}

interface EntityPickerJourney {
  calls: DeferredSearch[];
  changes: EntityPickerSubject[][];
}

let connectedJourney: EntityPickerJourney | null = null;

function journeyResult(query: string): EntityPickerSubject[] {
  if (query === 'multi') {
    return [
      subject('journey-multi-a', 'Multi A', 'Novel', 2020, false),
      subject('journey-multi-b', 'Multi B', 'Novel', 2021, false),
    ];
  }
  return [subject(`journey-result-${query}`, `Result for ${query}`, 'Novel', 2024, false)];
}

function resolveJourneyQuery(query: string) {
  const call = connectedJourney?.calls.findLast((entry) => entry.query === query);
  call?.resolve?.(journeyResult(query));
}

function rejectJourneyQuery(query: string) {
  const call = connectedJourney?.calls.findLast((entry) => entry.query === query);
  call?.reject?.(new Error('temporary search failure'));
}

function ConnectedJourneyHarness() {
  const [value, setValue] = useState<EntityPickerSubject[]>([
    subject('journey-seed', 'Seed subject', 'Novel', 2020, false),
  ]);
  const [disabled, setDisabled] = useState(false);
  const [multiple, setMultiple] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [throwNext, setThrowNext] = useState(false);
  const [responseQuery, setResponseQuery] = useState('');
  const [, setRevision] = useState(0);
  const [journey] = useState<EntityPickerJourney>(() => ({ calls: [], changes: [] }));
  connectedJourney = journey;

  // Deliberately create a wrapper on each parent render. It must not restart an admitted query by identity alone.
  const search: EntityPickerSearch = (query, signal) => {
    const call: DeferredSearch = { query, signal };
    journey.calls.push(call);
    setRevision((current) => current + 1);
    if (throwNext) {
      setThrowNext(false);
      throw new Error('temporary synchronous failure');
    }
    return new Promise<readonly EntityPickerSubject[]>((resolve, reject) => {
      call.resolve = (items) => resolve(items);
      call.reject = (reason) => reject(reason);
    });
  };

  const choose = (items: EntityPickerSubject[]) => {
    journey.changes.push(items);
    // Echo equivalent values through new arrays and subject objects, as a controlled parent commonly does.
    setValue(items.map((item) => ({ ...item })));
  };
  const replacement = subject('journey-replacement', 'Replacement subject', 'Novel', 2022, false);
  const renamed = { ...replacement, title: 'Renamed replacement' };

  return (
    <div className="grid max-w-md gap-4">
      <div role="group" aria-label="Journey controls" className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setValue([replacement])}>
          Replace selection
        </button>
        <button type="button" onClick={() => setValue([])}>
          Clear selection
        </button>
        <button type="button" onClick={() => setValue([renamed])}>
          Refresh title
        </button>
        <button type="button" onClick={() => setDisabled(true)}>
          Disable picker
        </button>
        <button type="button" onClick={() => setDisabled(false)}>
          Enable picker
        </button>
        <button type="button" onClick={() => setMultiple(true)}>
          Use multiple selection
        </button>
        <button type="button" onClick={() => setThrowNext(true)}>
          Throw next search
        </button>
        <button type="button" onClick={() => setRevision((current) => current + 1)}>
          Rerender parent
        </button>
        <button type="button" onClick={() => setMounted(false)}>
          Unmount picker
        </button>
      </div>
      <label className="grid gap-1">
        Response query
        <input value={responseQuery} onChange={(event) => setResponseQuery(event.currentTarget.value)} />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={() => resolveJourneyQuery(responseQuery)}>
          Resolve search
        </button>
        <button type="button" onClick={() => rejectJourneyQuery(responseQuery)}>
          Reject search
        </button>
      </div>
      <output aria-label="Search calls">{journey.calls.length}</output>
      <output aria-label="Selection changes">{journey.changes.length}</output>
      {mounted ? (
        <EntityPicker
          label="Journey subject"
          search={search}
          src={coverSrc}
          value={value}
          multiple={multiple}
          disabled={disabled}
          debounce={250}
          onValueChange={choose}
        />
      ) : null}
    </div>
  );
}

function activeJourney(): EntityPickerJourney {
  if (!connectedJourney) throw new Error('The connected EntityPicker harness is not mounted.');
  return connectedJourney;
}

export const ConnectedSelectionLifetime: Story = {
  render: () => <ConnectedJourneyHarness />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const queryInput = () => canvas.getByRole('combobox', { name: 'Journey subject' });
    const responseInput = canvas.getByRole('textbox', { name: 'Response query' });
    const calls = () => activeJourney().calls;
    const changes = () => activeJourney().changes;
    const waitForCalls = async (length: number) => waitFor(() => expect(calls()).toHaveLength(length));
    const response = async (query: string, action: 'resolve' | 'reject' = 'resolve') => {
      await userEvent.clear(responseInput);
      await userEvent.type(responseInput, query);
      await userEvent.click(
        canvas.getByRole('button', { name: action === 'resolve' ? 'Resolve search' : 'Reject search' }),
      );
    };
    const typeQuery = async (query: string) => {
      await userEvent.clear(queryInput());
      await userEvent.type(queryInput(), query);
    };
    const settleFor = async (query: string, action: 'resolve' | 'reject' = 'resolve') => {
      await response(query, action);
    };
    const settleAndWait = async (query: string, name: RegExp | string) => {
      await settleFor(query);
      await enabled(name);
    };
    const initialCalls = calls().length;

    await expect(queryInput()).toHaveValue('Seed subject');
    await typeQuery('queued');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace selection' }));
    await waitFor(() => expect(queryInput()).toHaveValue('Replacement subject'));
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await expect(calls()).toHaveLength(initialCalls);

    await typeQuery('clear-pending');
    await waitForCalls(initialCalls + 1);
    const clearPending = calls().at(-1)!;
    await userEvent.click(canvas.getByRole('button', { name: 'Rerender parent' }));
    await expect(clearPending.signal.aborted).toBe(false);
    await expect(calls()).toHaveLength(initialCalls + 1);
    await userEvent.click(canvas.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(queryInput()).toHaveValue(''));
    await expect(clearPending.signal.aborted).toBe(true);
    await settleFor('clear-pending');
    await expect(screen.queryByRole('option')).toBeNull();

    await userEvent.click(canvas.getByRole('button', { name: 'Replace selection' }));
    await typeQuery('title-pending');
    await waitForCalls(initialCalls + 2);
    const titlePending = calls().at(-1)!;
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh title' }));
    await waitFor(() => expect(queryInput()).toHaveValue('Renamed replacement'));
    await expect(titlePending.signal.aborted).toBe(true);
    await settleFor('title-pending');
    await expect(screen.queryByRole('option')).toBeNull();

    await typeQuery('slow-a');
    await waitForCalls(initialCalls + 3);
    const slowA = calls().at(-1)!;
    await typeQuery('slow-b');
    await waitForCalls(initialCalls + 4);
    await expect(slowA.signal.aborted).toBe(true);
    await settleAndWait('slow-b', /Result for slow-b/);
    await settleFor('slow-a', 'reject');
    await expect(screen.getByRole('option', { name: /Result for slow-b/ })).toBeVisible();
    await expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    await typeQuery('slow-c');
    await waitForCalls(initialCalls + 5);
    const slowC = calls().at(-1)!;
    await typeQuery('slow-d');
    await waitForCalls(initialCalls + 6);
    await expect(slowC.signal.aborted).toBe(true);
    await settleAndWait('slow-d', /Result for slow-d/);
    await settleFor('slow-c');
    await expect(screen.getByRole('option', { name: /Result for slow-d/ })).toBeVisible();
    await expect(screen.queryByRole('option', { name: /Result for slow-c/ })).toBeNull();

    await typeQuery('disabled-pending');
    await waitForCalls(initialCalls + 7);
    const disabledPending = calls().at(-1)!;
    await userEvent.click(canvas.getByRole('button', { name: 'Disable picker' }));
    await expect(queryInput()).toBeDisabled();
    await expect(disabledPending.signal.aborted).toBe(true);
    await settleFor('disabled-pending');
    await expect(screen.queryByRole('option')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Enable picker' }));
    await expect(queryInput()).toHaveValue('disabled-pending');
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await expect(calls()).toHaveLength(initialCalls + 7);
    await userEvent.type(queryInput(), 'x');
    await waitForCalls(initialCalls + 8);
    await expect(calls().at(-1)?.query).toBe('disabled-pendingx');
    await settleAndWait('disabled-pendingx', /Result for disabled-pendingx/);

    await userEvent.click(canvas.getByRole('button', { name: 'Throw next search' }));
    await typeQuery('retry-me');
    await waitForCalls(initialCalls + 9);
    await expect(await screen.findByText('The search failed.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitForCalls(initialCalls + 10);
    await expect(calls().at(-1)?.query).toBe('retry-me');
    await settleAndWait('retry-me', /Result for retry-me/);
    const beforeSinglePick = calls().length;
    await choose(/Result for retry-me/);
    await waitFor(() => expect(changes()).toHaveLength(1));
    await expect(queryInput()).toHaveValue('Result for retry-me');
    await expect(calls()).toHaveLength(beforeSinglePick);

    await userEvent.click(canvas.getByRole('button', { name: 'Use multiple selection' }));
    await expect(queryInput()).toHaveValue('');
    await typeQuery('multi');
    await waitForCalls(initialCalls + 11);
    await settleFor('multi');
    await enabled(/Multi A/);
    const beforeMultiplePicks = calls().length;
    await choose(/Multi A/);
    await waitFor(() => expect(changes()).toHaveLength(2));
    await expect(queryInput()).toHaveValue('multi');
    await choose(/Multi B/);
    await waitFor(() => expect(changes()).toHaveLength(3));
    await expect(queryInput()).toHaveValue('multi');
    const selected = canvas.getByRole('list', { name: 'Selected' });
    await expect(within(selected).getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Multi A' }));
    await waitFor(() => expect(changes()).toHaveLength(4));
    await expect(within(selected).getAllByRole('listitem')).toHaveLength(2);
    await expect(queryInput()).toHaveValue('multi');
    await expect(calls()).toHaveLength(beforeMultiplePicks);

    const input = queryInput() as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!valueSetter) throw new Error('The browser input value setter is unavailable.');
    await act(async () => {
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      valueSetter.call(input, 'ime-draft');
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: 'ime-draft',
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await expect(calls()).toHaveLength(beforeMultiplePicks);
    await act(async () => {
      valueSetter.call(input, 'ime-final');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ime-final' }));
    });
    await waitForCalls(initialCalls + 12);
    await expect(calls().at(-1)?.query).toBe('ime-final');
    await settleAndWait('ime-final', /Result for ime-final/);

    await typeQuery('unmount-pending');
    await waitForCalls(initialCalls + 13);
    const beforeUnmount = changes().length;
    const unmounted = calls().at(-1)!;
    await userEvent.click(canvas.getByRole('button', { name: 'Unmount picker' }));
    await expect(unmounted.signal.aborted).toBe(true);
    await settleFor('unmount-pending');
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await expect(changes()).toHaveLength(beforeUnmount);
    await expect(canvas.queryByRole('combobox', { name: 'Journey subject' })).toBeNull();
  },
};
