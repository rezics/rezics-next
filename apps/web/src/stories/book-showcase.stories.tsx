import { useCallback } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { View } from '@rezics/composition';
import {
  book,
  bookContents,
  bookEditions,
  bookParts,
  bookSeries,
  bookStoryLabels,
  bookSummary,
  bookRealm,
} from '../kernel/fixtures/book-showcase';
import {
  bookDiscussionTitles,
  bookStorySubject,
  prepareBookShowcase,
  type BookScenario,
} from '../kernel/fake/book-showcase';
import { recordedBookState } from '../kernel/fake/library-entry-states';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { subjectViewHref } from '../subject/subject-href';
import { PageStory, pageReady } from './page';
import { chooseSelectValue, expectSelectValue } from './select-option';

function BookStory({
  state = 'rich',
  view = 'overview',
  member = true,
  subject = 'book',
  realm = false,
}: {
  state?: BookScenario;
  view?: View;
  member?: boolean;
  subject?: 'book' | 'edition' | 'series';
  realm?: boolean;
}) {
  const locale = getLocale();
  const prepareFixture = useCallback(() => prepareBookShowcase(state), [state]);
  const identity =
    subject === 'edition'
      ? { id: bookEditions[2]!.id, label: bookEditions[2]!.labels.en! }
      : subject === 'series'
        ? bookSeries
        : bookStorySubject(state);
  const localized = { id: identity.id, label: bookSummary(identity.id, locale).label.value };
  return (
    <PageStory
      previewNewTabs
      prepareFixture={prepareFixture}
      visitor={member ? 'Signed In' : 'Signed Out'}
      path={`${subjectViewHref(localized, locale, view)}${realm ? `?realm=${bookRealm}` : ''}`}
      ratingsFixture={state === 'sparse' ? 'subject-ratings-empty' : 'subject-ratings-global'}
    />
  );
}

const meta = {
  title: 'Library/Books',
  id: 'pages-library-books',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'An invented, comprehensive bibliography combining characteristics of several books. All names, editions, community writing and cover artwork are synthetic interface fixtures, using the current API, definitions and viewer contracts; they are not recorded responses or native API acceptance. The real application shell, Book composition and router serve the complete visit. The Contents view uses three synthetic catalogue Parts with five interludes each; those rows contain no hosted chapter text, which remains in the separate Books/Hosted Book reader stories. Explore every tab, open an edition or series, and use browser Back/Forward. Review entries stay at their named state until you act. Interaction entries run scripted journeys with the same controls and fixtures. Use shared Locale, Theme and phone390/desktop1280 globals on every entry.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = { canvasElement: HTMLElement };
const supportedViews: View[] = [
  'overview',
  'editions',
  'contents',
  'characters',
  'credits',
  'relations',
  'reviews',
  'discussion',
  'lists',
  'details',
];

function tabs(element: HTMLElement) {
  return element.querySelector<HTMLElement>('[data-slot="view-tabs"]')!;
}
async function atView(context: Context, view: View) {
  await pageReady(context);
  await waitFor(() =>
    expect(tabs(context.canvasElement).querySelector('[aria-current="page"]')).toHaveAttribute('data-view', view),
  );
}
async function visit(context: Context, view: View) {
  const link = tabs(context.canvasElement).querySelector<HTMLAnchorElement>(`a[data-view="${view}"]`)!;
  await userEvent.click(link);
  await atView(context, view);
}
async function bookReady(context: Context) {
  await atView(context, 'overview');
  const title = bookSummary(book.id, getLocale()).label.value;
  await expect(await within(context.canvasElement).findByRole('heading', { level: 1, name: title })).toBeVisible();
  await waitFor(() =>
    expect(context.canvasElement.querySelector('[data-slot="subject-summary"]')).toHaveTextContent(
      'In a harbour city where the tide returns lost objects',
    ),
  );
  await waitFor(() => {
    const image = context.canvasElement.querySelector<HTMLImageElement>('[data-slot="subject-header"] img');
    expect(image?.naturalWidth).toBeGreaterThan(0);
    expect(image?.currentSrc).toContain(`/media/${bookSummary(book.id, getLocale()).cover?.media}/webp-`);
  });
  await expect(context.canvasElement).not.toHaveTextContent(/unlabelled/i);
}
async function historyTo(context: Context, direction: 'back' | 'forward', view: View) {
  window.history[direction]();
  await atView(context, view);
}

export const RichMember: Story = {
  name: 'Book · member',
  render: () => <BookStory />,
  play: bookReady,
};
export const RichSignedOut: Story = {
  name: 'Book · signed out',
  render: () => <BookStory member={false} />,
  play: async (context) => {
    await bookReady(context);
    await expect(within(context.canvasElement).queryByRole('combobox', { name: m.library_subject_entry() })).toBeNull();
  },
};
export const Editions: Story = {
  render: () => <BookStory view="editions" />,
  play: async (context) => {
    await atView(context, 'editions');
    await expect(
      await within(context.canvasElement).findByRole('link', { name: bookEditions[0]!.labels.en! }),
    ).toBeVisible();
  },
};
export const Contents: Story = {
  render: () => <BookStory view="contents" />,
  play: async (context) => {
    await atView(context, 'contents');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: bookParts[0]!.labels.en! })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: bookParts[1]!.labels.en! })).toBeVisible();
  },
};
export const Characters: Story = {
  render: () => <BookStory view="characters" />,
  play: (context) => atView(context, 'characters'),
};
export const Credits: Story = {
  render: () => <BookStory view="credits" />,
  play: (context) => atView(context, 'credits'),
};
export const Relations: Story = {
  render: () => <BookStory view="relations" />,
  play: (context) => atView(context, 'relations'),
};
export const Reviews: Story = {
  render: () => <BookStory view="reviews" />,
  play: async (context) => {
    await atView(context, 'reviews');
    await expect(
      await within(context.canvasElement).findByRole('link', { name: 'A city worth getting lost in' }),
    ).toBeVisible();
  },
};
export const Discussion: Story = {
  render: () => <BookStory view="discussion" />,
  play: async (context) => {
    await atView(context, 'discussion');
    await expect(
      await within(context.canvasElement).findByRole('link', { name: bookDiscussionTitles[0] }),
    ).toBeVisible();
  },
};
export const Lists: Story = { render: () => <BookStory view="lists" />, play: (context) => atView(context, 'lists') };
export const Details: Story = {
  render: () => <BookStory view="details" />,
  play: async (context) => {
    await atView(context, 'details');
    await expect(
      await within(context.canvasElement).findByText(bookStoryLabels.author!, { exact: true }),
    ).toBeVisible();
    await expect(
      await within(context.canvasElement).findByRole('link', { name: 'Lantern Quay bibliography' }),
    ).toBeVisible();
  },
};
export const EditionReturn: Story = {
  name: 'Edition → same Book',
  render: () => <BookStory subject="edition" realm />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: bookEditions[2]!.labels.en! })).toBeVisible();
    const link = (await canvas.findAllByRole('link', { name: bookSummary(book.id, getLocale()).label.value }))[0]!;
    await expect(new URL(link.getAttribute('href')!, window.location.origin).searchParams.get('realm')).toBe(bookRealm);
  },
};
export const SeriesReturn: Story = {
  name: 'Series → ordered Book → series',
  render: () => <BookStory subject="series" view="contents" realm />,
  play: async (context) => {
    await atView(context, 'contents');
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: bookSeries.label }),
    ).toBeVisible();
  },
};
export const SparseData: Story = {
  render: () => <BookStory state="sparse" member={false} />,
  play: async (context) => {
    await atView(context, 'overview');
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: 'A Map Still Unfolding' }),
    ).toBeVisible();
  },
};
export const SectionRetry: Story = {
  name: 'Independent editions failure and retry',
  render: () => <BookStory state="failure" view="editions" />,
  play: async (context) => {
    await atView(context, 'editions');
    await expect(
      await within(context.canvasElement).findByRole('link', { name: m.subject_section_retry() }),
    ).toBeVisible();
  },
};
export const PermissionLimited: Story = {
  name: 'Member with limited contribution permission',
  render: () => <BookStory state="limited" />,
  play: bookReady,
};
export const LongMultilingualText: Story = {
  render: () => <BookStory state="long" />,
  play: async (context) => {
    await atView(context, 'overview');
    await expect(await within(context.canvasElement).findByRole('heading', { level: 1 })).toHaveTextContent(
      bookSummary(bookStorySubject('long').id, getLocale()).label.value,
    );
  },
};
export const MemberReadback: Story = {
  name: 'Member library and rating readback',
  render: () => <BookStory />,
  play: async (context) => {
    await bookReady(context);
    const canvas = within(context.canvasElement);
    const state = await canvas.findByRole('combobox', { name: m.library_subject_entry() });
    await waitFor(() => expect(state).toBeEnabled());
    await expectSelectValue(state, recordedBookState(1)!);
    await expect(await canvas.findByRole('slider', { name: 'How much did you like this work?' })).toHaveAttribute(
      'aria-valuenow',
      '17',
    );
  },
};

export const TabNavigationInteraction: Story = {
  name: 'Interaction · all Book tabs and Back/Forward',
  render: () => <BookStory />,
  tags: ['interaction'],
  play: async (context) => {
    const frameUrl = window.location.href;
    await bookReady(context);
    // Visit the full route compositions, then return the main entry to its Overview.
    for (const view of supportedViews.slice(1)) {
      await visit(context, view);
      await expect(tabs(context.canvasElement).querySelector(`a[data-view="${view}"]`)).toHaveAttribute(
        'href',
        expect.stringContaining(book.id),
      );
    }
    await visit(context, 'overview');
    await historyTo(context, 'back', 'details');
    await historyTo(context, 'forward', 'overview');
    await expect(window.location.href).toBe(frameUrl);
  },
};
export const SignedOutNavigationInteraction: Story = {
  name: 'Interaction · signed-out reviews and return',
  render: () => <BookStory member={false} />,
  tags: ['interaction'],
  play: async (context) => {
    await bookReady(context);
    await expect(within(context.canvasElement).queryByRole('combobox', { name: m.library_subject_entry() })).toBeNull();
    await visit(context, 'reviews');
    await expect(
      await within(context.canvasElement).findByRole('link', { name: 'A city worth getting lost in' }),
    ).toBeVisible();
    await visit(context, 'overview');
  },
};
export const EditionsPaginationInteraction: Story = {
  name: 'Interaction · editions continuation and Back',
  render: () => <BookStory view="editions" />,
  tags: ['interaction'],
  play: async (context) => {
    await atView(context, 'editions');
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: bookEditions[0]!.labels.en! })).toBeVisible();
    await expect(await canvas.findByRole('link', { name: bookEditions[2]!.labels.en! })).toBeVisible();
    const next = await canvas.findByRole('link', { name: m.subject_section_more({ label: m.subject_editions() }) });
    const cursor = new URL(next.getAttribute('href')!, window.location.origin).searchParams.get('cursor');
    await expect(cursor).toMatch(/^book-window-/);
    await userEvent.click(next);
    await expect(await canvas.findByRole('link', { name: bookEditions[14]!.labels.en! })).toBeVisible();
    await historyTo(context, 'back', 'editions');
    await expect(await canvas.findByRole('link', { name: bookEditions[0]!.labels.en! })).toBeVisible();
  },
};
export const NestedContentsReturnInteraction: Story = {
  name: 'Interaction · nested contents item and exact return',
  render: () => <BookStory view="contents" />,
  tags: ['interaction'],
  parameters: {
    docs: {
      description: {
        story:
          'Summary: Three released catalogue Parts group the 15 synthetic interludes; opening an item preserves the exact originating Book address.',
      },
    },
  },
  play: async (context) => {
    const rootContents = window.location.href;
    await atView(context, 'contents');
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: bookParts[0]!.labels.en! }));
    await expect(await canvas.findByRole('heading', { level: 1, name: bookParts[0]!.labels.en! })).toBeVisible();
    await visit(context, 'contents');
    const partContents = window.location.href;
    const item = await canvas.findByRole('link', { name: bookContents[0]!.labels.en! });
    await expect(item.closest('li')!).toHaveTextContent(bookStoryLabels.bookType!);
    const itemReturn = new URL(
      new URL(item.getAttribute('href')!, window.location.origin).searchParams.get('via')!,
      window.location.origin,
    );
    await expect(itemReturn.pathname).toContain(`/subjects/${bookParts[0]!.id}/contents`);
    await expect(itemReturn.searchParams.get('streamProperty')).toBe('wdt:P361');
    await expect(itemReturn.searchParams.get('streamDirection')).toBe('inverse');
    await expect(itemReturn.hash).toBe('#literary-reader');
    await userEvent.click(item);
    await expect(await canvas.findByRole('heading', { level: 1, name: bookContents[0]!.labels.en! })).toBeVisible();
    await historyTo(context, 'back', 'contents');
    await expect(window.location.href).toBe(partContents);
    await historyTo(context, 'back', 'overview');
    await historyTo(context, 'back', 'contents');
    await expect(window.location.href).toBe(rootContents);
  },
};
export const ReviewReturnInteraction: Story = {
  name: 'Interaction · review continuation, reader and return',
  render: () => <BookStory view="reviews" />,
  tags: ['interaction'],
  play: async (context) => {
    await atView(context, 'reviews');
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.subject_community_more() }));
    const review = await canvas.findByRole('link', { name: 'Every borrowed day has a cost' });
    await userEvent.click(review);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Every borrowed day has a cost' })).toBeVisible();
    await historyTo(context, 'back', 'reviews');
    await visit(context, 'overview');
    await bookReady(context);
  },
};
export const EditionReturnInteraction: Story = {
  name: 'Interaction · edition → same Book → edition',
  render: () => <BookStory subject="edition" realm />,
  tags: ['interaction'],
  play: async (context) => {
    const frameUrl = window.location.href;
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const returnLink = (
      await canvas.findAllByRole('link', { name: bookSummary(book.id, getLocale()).label.value })
    )[0]!;
    await expect(returnLink).toHaveAttribute('href', expect.stringContaining(book.id));
    await expect(new URL(returnLink.getAttribute('href')!, window.location.origin).searchParams.get('realm')).toBe(
      bookRealm,
    );
    await userEvent.click(returnLink);
    await bookReady(context);
    await visit(context, 'editions');
    const edition = await canvas.findByRole('link', { name: bookEditions[2]!.labels.en! });
    await expect(new URL(edition.getAttribute('href')!, window.location.origin).searchParams.get('realm')).toBe(
      bookRealm,
    );
    await userEvent.click(edition);
    await expect(await canvas.findByRole('heading', { level: 1, name: bookEditions[2]!.labels.en! })).toBeVisible();
    await historyTo(context, 'back', 'editions');
    await expect(
      await canvas.findByRole('heading', { level: 1, name: bookSummary(book.id, getLocale()).label.value }),
    ).toBeVisible();
    window.history.forward();
    await expect(await canvas.findByRole('heading', { level: 1, name: bookEditions[2]!.labels.en! })).toBeVisible();
    await expect(window.location.href).toBe(frameUrl);
  },
};
export const SeriesReturnInteraction: Story = {
  name: 'Interaction · series → ordered Book → series',
  render: () => <BookStory subject="series" view="contents" realm />,
  tags: ['interaction'],
  play: async (context) => {
    const frameUrl = window.location.href;
    await atView(context, 'contents');
    const canvas = within(context.canvasElement);
    const volume = await canvas.findByRole('link', { name: bookSummary(book.id, getLocale()).label.value });
    await expect(new URL(volume.getAttribute('href')!, window.location.origin).searchParams.get('realm')).toBe(
      bookRealm,
    );
    await userEvent.click(volume);
    await bookReady(context);
    await userEvent.click((await canvas.findAllByRole('link', { name: bookSeries.label }))[0]!);
    await expect(await canvas.findByRole('heading', { level: 1, name: bookSeries.label })).toBeVisible();
    window.history.back();
    await bookReady(context);
    window.history.forward();
    await expect(await canvas.findByRole('heading', { level: 1, name: bookSeries.label })).toBeVisible();
    await expect(window.location.href).toBe(frameUrl);
  },
};
export const SectionRetryInteraction: Story = {
  name: 'Interaction · editions retry and independent reviews',
  render: () => <BookStory state="failure" view="editions" />,
  tags: ['interaction'],
  play: async (context) => {
    await atView(context, 'editions');
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('link', { name: m.subject_section_retry() }));
    await expect(await canvas.findByRole('link', { name: bookEditions[0]!.labels.en! })).toBeVisible();
    await visit(context, 'reviews');
    await expect(await canvas.findByRole('link', { name: 'A city worth getting lost in' })).toBeVisible();
  },
};
export const PermissionLimitedInteraction: Story = {
  name: 'Interaction · denied rating and saved readback',
  render: () => <BookStory state="limited" />,
  tags: ['interaction'],
  play: async (context) => {
    await bookReady(context);
    const canvas = within(context.canvasElement);
    const slider = await canvas.findByRole('slider', { name: 'How much did you like this work?' });
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.click(canvas.getByRole('button', { name: m.subject_rating_control_save() }));
    await expect(await canvas.findByText(m.subject_rating_control_error())).toBeVisible();
    await visit(context, 'details');
    await visit(context, 'overview');
    await expect(await canvas.findByRole('slider', { name: 'How much did you like this work?' })).toHaveAttribute(
      'aria-valuenow',
      '17',
    );
  },
};
export const MemberReadbackInteraction: Story = {
  name: 'Interaction · library and rating writes read back',
  render: () => <BookStory />,
  tags: ['interaction'],
  play: async (context) => {
    await bookReady(context);
    const canvas = within(context.canvasElement);
    const state = await canvas.findByRole('combobox', { name: m.library_subject_entry() });
    await waitFor(() => expect(state).toBeEnabled());
    await chooseSelectValue(state, recordedBookState(2)!);
    await expectSelectValue(
      await canvas.findByRole('combobox', { name: m.library_subject_entry() }),
      recordedBookState(2)!,
    );
    const slider = await canvas.findByRole('slider', { name: 'How much did you like this work?' });
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.click(canvas.getByRole('button', { name: m.subject_rating_control_save() }));
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuenow', '18'));
    await visit(context, 'details');
    await visit(context, 'overview');
    await expect(await canvas.findByRole('slider', { name: 'How much did you like this work?' })).toHaveAttribute(
      'aria-valuenow',
      '18',
    );
    await expectSelectValue(
      await canvas.findByRole('combobox', { name: m.library_subject_entry() }),
      recordedBookState(2)!,
    );
  },
};
