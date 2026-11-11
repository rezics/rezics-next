import { useEffect, useState, type MouseEvent } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { pickText } from '@rezics/composition';
import { BookCataloguePage } from '../books/catalogue/page';
import { bookCatalogueTypes, type BookCatalogueType, type BookCatalogueChoice } from '../books/catalogue/model';
import { literaryGrainExample } from '../features/catalogue/literary-reader/examples';
import { LiteraryReaderEntry } from '../features/catalogue/literary-reader/entry';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { SearchPage } from '../search/search';
import { discoverySearchHref, searchLoaderDeps, type SearchLoaderDeps } from '../search/search-params';
import { discoveryRequest } from '../search/search-request';
import { readSearchOutcome, searchUnavailablePage, type SearchOutcome } from '../search/search-recovery';
import type { DiscoveryPage } from '../search/discovery';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

const initialCursor = 'illustrative+/= edition frontier';

/** Illustrative native-format envelopes. These are not API recordings or native acceptance. */
function discovery(type: BookCatalogueType, locale: string): DiscoveryPage {
  const { work } = literaryGrainExample(type);
  const label = pickText(work.labels, locale);
  return {
    hits: [
      {
        key: { owner: 'semantic', kind: type, route: 0, id: work.id },
        matchEvidence: { state: 'unavailable' },
        summary: {
          kind: 'subject',
          value: {
            id: work.id,
            type,
            types: [type],
            label: { value: label.text, language: label.lang ?? 'en' },
            creativeWork: true,
            cover: null,
          },
        },
        labels: work.labels,
        descriptions: work.descriptions,
      },
    ],
    kinds: { values: [{ id: type, labels: bundledRelease.types[type]!.labels }], next: null },
    next: null,
    as_of: '2026-11-12T00:00:00Z',
  };
}

function choices(locale: string): BookCatalogueChoice[] {
  return bookCatalogueTypes.map((type) => {
    const definition = bundledRelease.types[type];
    const label = pickText(definition?.labels ?? {}, locale);
    return { type, state: 'ready', label: label.text, language: label.lang ?? null };
  });
}

function CatalogueResult({ address, sparse, unavailable }: { address: string; sparse: boolean; unavailable: boolean }) {
  const locale = getLocale();
  const params = new URL(address, 'https://story.invalid').searchParams;
  const state = searchLoaderDeps(Object.fromEntries(params));
  const type = state.type as BookCatalogueType;
  const [outcome, setOutcome] = useState<SearchOutcome>({ recovery: { status: 'loading' } });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setOutcome({ recovery: { status: 'loading' } });
    const page = discovery(type, locale);
    void readSearchOutcome(discoveryRequest(state, [locale]), async () => ({
      status: unavailable && retry === 0 ? 503 : 200,
      data: sparse && state.cursor ? { ...page, hits: [], next: 'illustrative sparse next' } : page,
    })).then((result) => {
      if (current) setOutcome(result);
    });
    return () => {
      current = false;
    };
  }, [address, locale, retry, sparse, unavailable]);
  return (
    <SearchPage
      query={state.query}
      locale={locale}
      cursor={state.cursor}
      searchHref={address}
      data={{ ...searchUnavailablePage(state), ...outcome }}
      onRetry={() => setRetry((value) => value + 1)}
    />
  );
}

/** Story navigation previews the installed destinations while production links retain their separate-tab semantics. */
function Visit({
  member = false,
  sparse = false,
  unavailable = false,
}: {
  member?: boolean;
  sparse?: boolean;
  unavailable?: boolean;
}) {
  const locale = getLocale();
  const initial: SearchLoaderDeps = {
    query: '',
    type: 'bf:Instance',
    facets: {},
    sort: undefined,
    cursor: sparse || unavailable ? initialCursor : undefined,
  };
  const [address, setAddress] = useState<string | undefined>(() =>
    sparse || unavailable ? discoverySearchHref(locale, initial) : undefined,
  );
  const [catalogue, setCatalogue] = useState<string>();
  const [selectedType, setSelectedType] = useState<BookCatalogueType>(
    sparse || unavailable ? 'bf:Instance' : 'schema:Book',
  );
  const visitor = member ? 'Signed In' : 'Signed Out';
  const pathname = address && new URL(address, 'https://story.invalid').pathname;
  const shelf = pathname === `/${locale}/library`;
  const reader = pathname?.includes('/subjects/');
  const browse = pathname === `/${locale}/search`;
  const intercept = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!link) return;
    const url = new URL(link.href);
    if (!url.pathname.startsWith(`/${locale}/`)) return;
    if (
      url.pathname !== `/${locale}/search` &&
      url.pathname !== `/${locale}/library` &&
      !url.pathname.includes('/subjects/')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (url.pathname === `/${locale}/search`) {
      const type = url.searchParams.get('type') as BookCatalogueType;
      setSelectedType(type);
      setCatalogue(target);
    }
    setAddress(target);
  };
  const input = literaryGrainExample(selectedType);
  return (
    <div onClickCapture={intercept}>
      <aside className="border-b p-3 text-sm" role="note">
        Illustrative envelopes; use the locale, theme and phone/desktop globals. Destination links are previewed in this
        story.
        {address && (
          <button
            className="ml-3 min-h-11 underline"
            onClick={() => setAddress(reader || shelf ? catalogue : undefined)}
          >
            Return to initiating catalogue
          </button>
        )}
      </aside>
      {shelf ? (
        <PageStory key={address} visitor={visitor} path={address!} />
      ) : (
        <PatternStory key={`${locale}:${address ?? 'entry'}`} visitor={visitor} path={address ?? `/${locale}/books`}>
          <AppShell>
            {reader ? (
              <LiteraryReaderEntry {...input} locale={locale} />
            ) : browse ? (
              <CatalogueResult address={address!} sparse={sparse} unavailable={unavailable} />
            ) : (
              <BookCataloguePage locale={locale} choices={choices(locale)} />
            )}
          </AppShell>
        </PatternStory>
      )}
    </div>
  );
}

const meta = {
  title: 'Library/Book catalogue visit',
  id: 'pages-books-catalogue',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Public Book Library entry, canonical Search rendering, ordinary literary reader and native Library route. The public discovery and literary envelopes are illustrative. The member destination uses the installed recorded Library transport and its existing action controls. Shared locale globals cover en, zh-Hant, zh-Hans, ja, ko, de, fr and es; phone390 and desktop1280 and both themes remain available. These authored stories do not claim native, browser or visual acceptance.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AnonymousBrowse: Story = {
  render: () => <Visit key={getLocale()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(m.books_catalogue_title());
    const browse = canvas.getAllByRole('link', { name: new RegExp(m.books_catalogue_browse()) });
    await expect(browse).toHaveLength(3);
    await userEvent.click(browse[0]!);
    await canvas.findByText(pickText(literaryGrainExample('schema:Book').work.labels, getLocale()).text);
  },
};
export const MemberShelfHandoff: Story = {
  render: () => <Visit key={getLocale()} member />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const shelf = canvas.getAllByRole('link', { name: new RegExp(m.books_catalogue_shelf()) })[0]!;
    await expect(shelf).toHaveAttribute('href', `/${getLocale()}/library?type=schema%3ABook`);
    await userEvent.click(shelf);
    await canvas.findByRole('heading', { name: m.library_tracked_entries() });
  },
};
export const Sparse: Story = {
  render: () => <Visit key={getLocale()} sparse />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.search_recovery_sparse());
    await expect(canvasElement.querySelector('[data-search-recovery="sparse"] a')).not.toBeNull();
  },
};
export const UnavailableRecovery: Story = {
  render: () => <Visit key={getLocale()} unavailable />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.search_facet_retry() }));
    await canvas.findByText(pickText(literaryGrainExample('bf:Instance').work.labels, getLocale()).text);
  },
};
