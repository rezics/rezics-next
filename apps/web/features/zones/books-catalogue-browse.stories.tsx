import type { ZoneContext } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { zoneImage, zoneText } from '../realm/adapt.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import { realmMessagesFor, RealmPageStory } from '../realm/story-page.tsx';
import { realmHref, siteHref } from '../realm/route.ts';
import type { Loaded, RealmHeader, ZoneBrowsePage, ZoneBrowseQuery } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { ZoneBrowse } from './browse.tsx';
import { parseBrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { cardRenderer } from './zone-home.tsx';

const record = books as AnswerRecord;
const persona = 'visitor';
const locale = 'en';
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);
const sample = (label: string) => {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded Books answer: ${label}`);
  return found;
};

/** Select the recorded request, including its wire order, rather than inventing story data. */
function requestOf(label: string) {
  const url = new URL(sample(label).path, 'https://recorded.invalid');
  const sort = url.searchParams.get('sort');
  if (sort !== 'newest' && sort !== 'updated' && sort !== 'relevance') throw new Error('Missing recorded sort');
  const query: ZoneBrowseQuery = { sort, limit: Number(url.searchParams.get('limit')),
    type: url.searchParams.getAll('type'),
    ...(url.searchParams.has('q') ? { q: url.searchParams.get('q')! } : {}),
    ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) };
  return { realm: url.pathname.split('/')[3]!, query,
    state: parseBrowseState({ sort, q: query.q, type: query.type?.map(type => type.replace('https://schema.org/', 'schema:')) }) };
}

function RecordedBooksBrowse({ label, state }: { label: string; state: RecordedState }) {
  const [shown, setShown] = useState<{ zone: ZoneContext; page: Loaded<BrowseModel> | null } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(record, persona, [
      { label, state }, { label: 'facet-labels', state: 'populated' },
      { label: 'realm-context', state: 'populated' }, { label: 'zone-presentation', state: 'populated' },
    ], { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    const request = requestOf(label);
    const zoneId = new URL(sample('zone-presentation').path, 'https://recorded.invalid').pathname.split('/')[3]!;
    async function load() {
      const [header, presentation] = await Promise.all([
        main.v1.realms({ realm: request.realm }).get(),
        main.v1.zones({ id: zoneId }).presentation.get(),
      ]);
      if (header.error || !header.data || presentation.error || !presentation.data) throw new Error('Recorded browse frame failed');
      // This outcome's public Books catalogue runs the recorded fallback presentation.
      const ref = request.realm;
      const zone: ZoneContext = { slug: presentation.data.official, realm: header.data.id,
        name: zoneText(header.data.name), description: zoneText(header.data.description),
        icon: zoneImage(header.data.icon), hero: zoneImage(header.data.banner),
        tokens: presentation.data.presentation.tokens, locale,
        links: { home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
          works: siteHref(locale, ref, ['browse']), discussions: realmHref(locale, ref, 'discussions'),
          decisions: realmHref(locale, ref, 'decisions'), about: realmHref(locale, ref, 'about') } };
      if (active) setShown({ zone, page: null });
      const [page, facets] = await Promise.all([
        readBrowseAnswer(main, request.realm, request.query), readFacetAnswer(main),
      ]);
      const built = buildBrowsePage({ page, facets, base: zone.links.browse, zoneName: zone.name.value,
        state: request.state, context: { realm: request.realm, ref, locale }, locale, messages });
      if (active) setShown({ zone, page: built });
    }
    void load().catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error(String(reason))); });
    return () => { active = false; replay.dispose(); };
  }, [label, state]);
  if (error) throw error;
  const loading = <PageContainer><p role="status" aria-busy="true">{shellMessages.loading}</p></PageContainer>;
  if (!shown) return loading;
  return <RealmPageStory zone={shown.zone} locale={locale} site>
    {!shown.page ? loading : shown.page.ok
      ? <ZoneBrowse model={shown.page.data} messages={messages} card={cardRenderer(shown.zone, null, locale, messages)} />
      : <RealmUnavailable messages={realmMessages} failure={shown.page.failure} reference={shown.page.reference} />}
  </RealmPageStory>;
}

const meta = { title: 'Zones/Books catalogue browse', component: RecordedBooksBrowse,
  parameters: { route: { pathname: localizedPath(spaceHref('books', 'site', ['browse']), locale) } },
  globals: { locale },
} satisfies Meta<typeof RecordedBooksBrowse>;
export default meta;
type Story = StoryObj<typeof meta>;

const recordedPage = (label: string) => sample(label).answer as ZoneBrowsePage;
const resultText = (label: string) => {
  const matches = recordedPage(label).matches;
  const t = materializeData(messages, { locale });
  return matches.kind === 'exact' ? t.results(matches.value) : t.resultsAtLeast({ count: String(matches.value) });
};

export const PopulatedVisitor: Story = {
  args: { label: 'browse-newest-0', state: 'populated' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const answer = recordedPage('browse-newest-0');
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('browse-newest-0'));
    const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
    await expect(sorts.getByRole('link', { name: messages.sortNewest })).toHaveAttribute('aria-current', 'true');
    await expect(sorts.getByRole('link', { name: messages.sortUpdated })).toBeVisible();
    const next = canvas.getByRole('link', { name: messages.next });
    await expect(next).toBeVisible();
    await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(answer.nextCursor);
  },
};

export const SearchResultsVisitor: Story = {
  args: { label: 'search-relevance-0', state: 'populated' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const answer = recordedPage('search-relevance-0');
    await expect(await canvas.findByRole('link', { name: answer.items[0]!.title.value })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('search-relevance-0'));
    await expect(canvas.getByRole('searchbox')).toHaveValue(answer.query.text);
    const sorts = within(canvas.getByRole('navigation', { name: messages.sortLabel }));
    for (const name of [messages.sortRelevance, messages.sortNewest, messages.sortUpdated])
      await expect(sorts.getByRole('link', { name })).toBeVisible();
    await expect(sorts.getByRole('link', { name: messages.sortRelevance })).toHaveAttribute('aria-current', 'true');
  },
};

export const EmptyVisitor: Story = {
  args: { label: 'search-no-match', state: 'empty' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: messages.browseEmptyTitle })).toBeVisible();
    await expect(canvas.getByText(messages.browseEmptyBody)).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(resultText('search-no-match'));
    await expect(canvas.queryByRole('link', { name: messages.next })).toBeNull();
  },
};

export const ErrorVisitor: Story = {
  args: { label: 'unsupported-query-shape', state: 'error' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: realmMessages.movedTitle })).toBeVisible();
    await expect(canvas.getByText(realmMessages.movedBody)).toBeVisible();
    await expect(canvas.getByRole('button', { name: realmMessages.retry })).toBeVisible();
    await expect(canvas.queryByText(messages.browseEmptyTitle)).toBeNull();
  },
};

export const LoadingVisitor: Story = {
  args: { label: 'browse-newest-0', state: 'loading' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // The frame has answered before this assertion; the selected browse call remains held.
    await expect(await canvas.findByText((sample('realm-context').answer as RealmHeader).name.value)).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(shellMessages.loading);
    await expect(canvas.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.queryByText(recordedPage('browse-newest-0').items[0]!.title.value)).toBeNull();
  },
};
