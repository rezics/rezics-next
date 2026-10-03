import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { direction } from '@rezics/main/language';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { cardRenderer } from '../zones/zone-home.tsx';
import { facetRegistry } from '../../../../packages/model/src/generated/facets.ts';
import { releaseWork } from './adapt.ts';
import { ReleaseBrowse, ReleaseBrowseHeader } from './browse.tsx';
import { resolveReleaseFilter, type ServedFacet } from './registry.ts';
import { parseReleaseFilter } from './state.ts';

// The release filter on a Zone with no package of its own: the control built from the served registry, the chosen
// conditions as chips and the paging and empty states. A Zone's own cards and words are in
// `official-zone-stories`. Books could use the same control for edition format and language.

const spec: ZoneReleaseFilterSpec = {
  label: 'Find an edition',
  apply: 'Show matching books',
  clear: 'Clear filters',
  summary: 'Books with one edition that meets every filter',
  coverKind: 'book',
  noMatch: {
    title: 'No edition meets every filter',
    body: 'A book is listed only when one edition has them all.',
  },
  keepLooking: 'Nothing in this stretch matched. Show the next page to keep looking.',
  fields: [
    {
      facet: 'releaseLanguage',
      label: 'Language',
      any: 'Any language',
      options: [
        { value: 'en', label: 'English' },
        { value: 'ja', label: 'Japanese' },
      ],
    },
    {
      facet: 'releasePlatform',
      label: 'Format',
      any: 'Any format',
      options: [
        { value: 'paperback', label: 'Paperback' },
        { value: 'ebook', label: 'E-book' },
      ],
    },
  ],
};
const served = Object.values(facetRegistry) as unknown as ServedFacet[];
const filter = resolveReleaseFilter(spec, served, 'en')!;

function Browse({
  locale,
  params,
  withResults,
  next = null,
}: {
  locale: UiLocale;
  params: Record<string, string>;
  withResults: boolean;
  next?: string | null;
}) {
  const zone = zoneFor(locale);
  const messages = zoneMessagesFor(locale);
  const state = parseReleaseFilter(params, filter);
  const base = zone.links.browse;
  const context = {
    locale,
    ref: 'books',
    realm: 'https://rezics.com/id/00000000-0000-7000-8000-000000000001',
  };
  const items = withResults
    ? ['Pride and Prejudice', 'Persuasion'].map((title, index) =>
        releaseWork(
          {
            id: `https://rezics.com/id/00000000-0000-7000-8000-00000000000${index + 2}`,
            title: {
              value: title,
              language: 'en',
              direction: direction('en', title),
              basis: 'requested',
            } as never,
            cover: null,
            matchedReleases: [],
            moreMatchedReleases: false,
          },
          state,
          spec,
          context,
          { releases: new Map(), realizations: new Map(), translators: new Map() },
        ),
      )
    : [];
  return (
    <RealmPageStory site zone={zone} locale={locale}>
      <ReleaseBrowse
        header={
          <ReleaseBrowseHeader
            zone={zone}
            pkg={null}
            spec={spec}
            filter={filter}
            state={state}
            base={base}
          />
        }
        spec={spec}
        filter={filter}
        state={state}
        base={base}
        items={items}
        next={next}
        locale={locale}
        messages={messages}
        firstPage="Back to the first page"
        card={cardRenderer(zone, null, locale, messages)}
      />
    </RealmPageStory>
  );
}

function zoneFor(locale: UiLocale) {
  // Edition browsing is a Site route; community discussions and decisions stay under /r.
  const home = localizedPath(spaceHref('books', 'site'), locale);
  return {
    slug: 'books',
    realm: 'https://rezics.com/id/00000000-0000-7000-8000-000000000001',
    name: { value: 'Books', lang: 'en', dir: direction('en', 'Books') },
    description: null,
    icon: null,
    hero: null,
    tokens: presetTokens.editorial,
    locale,
    links: {
      home,
      browse: `${home}/browse`,
      works: `${home}/browse`,
      discussions: localizedPath(spaceHref('books', 'community', ['discussions']), locale),
      decisions: localizedPath(spaceHref('books', 'community', ['decisions']), locale),
      about: localizedPath(spaceHref('books', 'community', ['about']), locale),
    },
  };
}

const meta = {
  title: 'Zones/Release filter',
  component: Browse,
  args: {
    locale: 'en',
    params: { releaseLanguage: 'en', releasePlatform: 'ebook' },
    withResults: true,
  },
  parameters: { route: { pathname: localizedPath(spaceHref('books', 'site', ['browse']), 'en') } },
} satisfies Meta<typeof Browse>;
export default meta;
type Story = StoryObj<typeof meta>;

const fits = async () =>
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Each chosen condition is a removable chip, and the control keeps its values. */
export const Filtered: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('form', { name: 'Find an edition' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    await expect(canvas.getByRole('combobox', { name: 'Format' })).toHaveTextContent('E-book');
    await expect(canvas.getByRole('link', { name: 'Remove filter: E-book' })).toHaveAttribute(
      'href',
      localizedPath(`${spaceHref('books', 'site', ['browse'])}?releaseLanguage=en`, 'en'),
    );
    await fits();
  },
};

/** Nothing meets every condition; a translated title alone is not an answer. */
export const NoMatch: Story = {
  args: { params: { releaseLanguage: 'th' }, withResults: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'No edition meets every filter' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      localizedPath(spaceHref('books', 'site', ['browse']), 'en'),
    );
  },
};

/** Main examines a bounded stretch of the library per page; an empty page that continues says so. */
export const KeepLooking: Story = {
  args: { withResults: false, next: 'cursor-2' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Nothing in this stretch matched/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor=cursor-2'),
    );
    await expect(
      canvas.queryByRole('heading', { name: 'No edition meets every filter' }),
    ).toBeNull();
  },
};

/** A later page leads back to the first. */
export const SecondPage: Story = {
  args: { params: { releaseLanguage: 'en', cursor: 'cursor-2' } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('link', { name: 'Back to the first page' }),
    ).toHaveAttribute(
      'href',
      localizedPath(`${spaceHref('books', 'site', ['browse'])}?releaseLanguage=en`, 'en'),
    );
  },
};

/** Keyboard only: tab through each select and on to the button */
export const Keyboard: Story = {
  args: { params: {}, withResults: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    canvas.getByRole('combobox', { name: 'Language' }).focus();
    await userEvent.tab();
    await expect(canvas.getByRole('combobox', { name: 'Format' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Show matching books' })).toHaveFocus();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('form', { name: 'Find an edition' }),
    ).toBeVisible();
    await fits();
  },
};
