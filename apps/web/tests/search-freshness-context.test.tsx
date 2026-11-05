import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchCoverage } from '../src/search/search-context/coverage';
import { resultFreshness } from '../src/search/search-context/observation';
import { searchUnavailablePage } from '../src/search/search-recovery';
import { discoverySearchHref } from '../src/search/search-params';
import { m } from '../src/paraglide/messages.js';

const privateOwnerIds = [
  'private-profile',
  'private-state-set',
  'private-state',
  '11111111-1111-4111-8111-111111111111',
  'private-session-profile',
  'private-holding-profile',
  'private-holding-kind',
  'private-holding-status',
];
const state = {
  query: 'Executed',
  type: undefined,
  facets: { genre: ['fiction'] },
  languages: ['fr'],
  filter: JSON.stringify({
    and: [
      { owner: { presence: true } },
      { owner: { state: { profileId: privateOwnerIds[0], stateSetId: privateOwnerIds[1], in: [privateOwnerIds[2]] } } },
      { owner: { label: { id: privateOwnerIds[3] } } },
      { owner: { session: { profileId: privateOwnerIds[4], lifecycle: 'abandoned' } } },
      {
        owner: {
          holding: {
            profileId: privateOwnerIds[5],
            kind: privateOwnerIds[6],
            status: privateOwnerIds[7],
          },
        },
      },
    ],
  }),
  cursor: 'old-generation',
  sort: undefined,
};
const timestamp = '2026-01-01T00:00:00.000Z';
test('invalid or missing observations never acquire freshness from a timestamp or empty page', () => {
  for (const value of [undefined, {}, { state: 'complete' }, { state: 'current', behind: 1 }])
    expect(resultFreshness(value, timestamp).state).toBe('unavailable');
  for (const time of ['invalid', '2026-02-30T00:00:00Z', '2026-01-01', ''])
    expect(resultFreshness({ state: 'current' }, time).state).toBe('unavailable');
});
test('executed context and explicit first-page refresh preserve languages and predicates across locales', () => {
  const data = searchUnavailablePage(state);
  const href = discoverySearchHref('en', { ...state, cursor: undefined });
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const html = renderToStaticMarkup(
      <SearchCoverage
        state={state}
        data={data}
        locale={locale}
        observation={{ as_of: timestamp, freshness: { state: 'catching-up' } }}
        refreshHref={href}
      />,
    );
    const visibleText = html.replace(/<[^>]*>/g, '');
    expect(html).toContain('<details>');
    expect(html).toContain('Executed');
    expect(html).toContain('fiction');
    expect(html).not.toContain('old-generation');
    expect(html).not.toContain(timestamp);
    expect(html).toContain('role="status"');
    expect(html).toContain(m.search_context_owner_presence({}, { locale }));
    expect(html).toContain(m.search_context_owner_state({}, { locale }));
    expect(html).toContain(m.search_context_owner_label({}, { locale }));
    expect(html).toContain(m.search_context_owner_session_abandoned({}, { locale }));
    expect(html).toContain(
      m.search_context_owner_holding(
        {
          fields: [
            m.search_context_owner_holding_profile({}, { locale }),
            m.search_context_owner_holding_kind({}, { locale }),
            m.search_context_owner_holding_status({}, { locale }),
          ].join(', '),
        },
        { locale },
      ),
    );
    for (const privateId of privateOwnerIds) expect(visibleText).not.toContain(privateId);
  }
  expect(href).toContain('fr');
  expect(href).toContain('fiction');
  expect(href).not.toContain('cursor');
});

test('invalid or unsupported executed filter context is unavailable, never Global', () => {
  const invalidContexts = [
    { filter: '{"realm":', invalidInput: { key: 'filter', value: '{"realm":' } },
    { filter: JSON.stringify({ futureCondition: { id: 'private-future-id' } }) },
  ];
  for (const invalidContext of invalidContexts) {
    const invalid = { ...state, ...invalidContext };
    const html = renderToStaticMarkup(
      <SearchCoverage
        state={invalid}
        data={searchUnavailablePage(invalid)}
        locale="en"
        observation={{ as_of: timestamp, freshness: { state: 'current' } }}
        refreshHref={discoverySearchHref('en', { ...invalid, cursor: undefined })}
      />,
    );
    const visibleText = html.replace(/<[^>]*>/g, '');
    expect(html).toContain(m.search_context_scope_unavailable({}, { locale: 'en' }));
    expect(html).toContain(m.search_context_predicate_unavailable({}, { locale: 'en' }));
    expect(html).not.toContain(m.header_search_global({}, { locale: 'en' }));
    expect(visibleText).not.toContain('futureCondition');
    expect(visibleText).not.toContain('private-future-id');
  }
});
