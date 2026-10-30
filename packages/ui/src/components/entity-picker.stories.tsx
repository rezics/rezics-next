import type { Meta, StoryObj } from '@storybook/react-vite';
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
  args: { search: fakeSearch({ offline }) },
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
    // A subject with no cover shows its initials, one with no year or type label shows only what it has.
    await expect(screen.getByRole('option', { name: /Untitled/ })).toHaveTextContent(/^U\s*Untitled$/);
    await expect(screen.getByRole('option', { name: /無題の物語/ })).toHaveTextContent(
      metaText(['Visual novel', '2011']),
    );
  },
};

export const PhoneWidth: Story = {
  decorators: [
    (Story) => (
      <div className="w-[360px] overflow-hidden">
        <Story />
      </div>
    ),
  ],
  args: { multiple: true },
  async play({ canvasElement }) {
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Subject' }), 'three');
    await choose(/The Three-Body Problem/);
    const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!;
    await expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(within(canvasElement).getByRole('list', { name: 'Selected' })).toBeVisible();
  },
};
