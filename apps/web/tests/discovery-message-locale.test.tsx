import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import type { AccountDiscoverySummary, DiscoveryPage, DiscoveryState } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { subjectHref } from '../src/subject/subject-href';

const unnamedId = '00000000-0000-4000-8000-000000000821';
const restartHref = '/search?q=Mira';
const regions = [
  ['en', 'zh-Hans'],
  ['zh-Hans', 'en'],
] as const;

function options(locale: string) {
  return { locale: locale as never };
}

function withAmbient<T>(ambient: string, run: () => T): T {
  const previous = getLocale();
  setLocale(ambient as never, { reload: false });
  try {
    return run();
  } finally {
    setLocale(previous, { reload: false });
  }
}

function mixedPage(): DiscoveryPage {
  const mira = discoveryExample.hits.find(
    (hit): hit is Extract<DiscoveryPage['hits'][number], { summary: { kind: 'account' } }> =>
      hit.summary.kind === 'account' && hit.summary.value.handle === 'mira',
  );
  const named = discoveryExample.hits.find(
    (hit): hit is Extract<DiscoveryPage['hits'][number], { summary: { kind: 'account' } }> =>
      hit.summary.kind === 'account' && hit.summary.value.displayName === 'Mira Reading Room',
  );
  if (!mira || !named) throw new Error('Expected authored Account results.');
  const unnamedValue: AccountDiscoverySummary = {
    ...mira.summary.value,
    id: unnamedId,
    handle: null,
    displayName: null,
  };
  return {
    ...discoveryExample,
    hits: [
      mira,
      named,
      {
        key: { owner: 'accounts', kind: 'account', route: 0, id: unnamedId },
        summary: { kind: 'account', value: unnamedValue },
      },
    ],
  };
}

function emptyPage(): DiscoveryPage {
  return { ...discoveryExample, hits: [] };
}

function render(state: DiscoveryState, locale: string) {
  return renderToStaticMarkup(createElement(DiscoveryResults, { state, locale, restartHref }));
}

function row(html: string, accountId: string): string {
  const match = html.match(new RegExp(`<li\\b(?=[^>]*data-discovery-account="${accountId}")[^>]*>[\\s\\S]*?<\\/li>`));
  if (!match) throw new Error(`Missing discovery account row ${accountId}.`);
  return match[0];
}

function together(state: DiscoveryState) {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(DiscoveryResults, { state, locale: 'en', restartHref }),
      createElement(DiscoveryResults, { state, locale: 'zh-Hans', restartHref }),
    ),
  );
}

test('mixed result fallback names and verified links follow each region locale despite the opposite ambient locale', () => {
  const original = getLocale();
  const page = mixedPage();
  const mira = page.hits[0]!;
  const named = page.hits[1]!;
  const state = { status: 'ready' as const, page };
  const accountKind = (locale: string) => page.kinds.values.find((kind) => kind.id === 'account')!.labels[locale];
  const verifiedHref = (locale: string) => subjectHref({ id: mira.key.id, label: 'Mira' }, locale).href;

  for (const [locale, ambient] of regions) {
    const html = withAmbient(ambient, () => {
      expect(getLocale()).toBe(ambient);
      return render(state, locale);
    });
    const miraRow = row(html, mira.key.id);
    const namedRow = row(html, named.key.id);
    const unnamedRow = row(html, unnamedId);
    expect(miraRow).toContain('>Mira</h2>');
    expect(miraRow).toContain('@mira');
    expect(miraRow).toContain(accountKind(locale));
    expect(miraRow).toContain(`href="/${locale}/@mira"`);
    expect(miraRow).toContain(m.discovery_verified_as({ name: 'Mira' }, options(locale)));
    expect(miraRow).toContain(`href="${verifiedHref(locale)}"`);
    expect(miraRow).not.toContain(m.discovery_verified_as({ name: 'Mira' }, options(ambient)));
    expect(namedRow).toContain('>Mira Reading Room</h2>');
    expect(namedRow).not.toContain('<a');
    expect(unnamedRow).toContain(`>${m.discovery_unnamed_account({}, options(locale))}</h2>`);
    expect(unnamedRow).not.toContain(`>${m.discovery_unnamed_account({}, options(ambient))}</h2>`);
    expect(unnamedRow).not.toContain(`href="/${locale}/@`);
    expect(unnamedRow).toContain(m.discovery_verified_as({ name: 'Mira' }, options(locale)));
    expect(unnamedRow).toContain(`href="${verifiedHref(locale)}"`);
    expect(html.indexOf(`data-discovery-account="${mira.key.id}"`)).toBeLessThan(
      html.indexOf(`data-discovery-account="${named.key.id}"`),
    );
    expect(html.indexOf(`data-discovery-account="${named.key.id}"`)).toBeLessThan(
      html.indexOf(`data-discovery-account="${unnamedId}"`),
    );
  }

  const both = withAmbient('ja', () => together(state));
  expect(both).toContain(m.discovery_unnamed_account({}, options('en')));
  expect(both).toContain(m.discovery_unnamed_account({}, options('zh-Hans')));
  expect(both).not.toContain(m.discovery_unnamed_account({}, options('ja')));
  expect(both).toContain('href="/en/@mira"');
  expect(both).toContain('href="/zh-Hans/@mira"');
  expect(both).toContain(verifiedHref('en'));
  expect(both).toContain(verifiedHref('zh-Hans'));
  expect(getLocale()).toBe(original);
});

test('empty and recovery messages and actions follow each region locale despite the opposite ambient locale', () => {
  const original = getLocale();
  const cases: {
    state: DiscoveryState;
    role: 'status' | 'alert';
    busy?: true;
    message: (locale: string) => string;
    action?: (locale: string) => string;
  }[] = [
    {
      state: { status: 'ready', page: emptyPage() },
      role: 'status',
      message: (locale) => m.search_no_results({}, options(locale)),
    },
    {
      state: { status: 'loading' },
      role: 'status',
      busy: true,
      message: (locale) => m.discovery_loading({}, options(locale)),
    },
    {
      state: { status: 'denied' },
      role: 'alert',
      message: (locale) => m.discovery_denied({}, options(locale)),
      action: (locale) => m.search_facet_retry({}, options(locale)),
    },
    {
      state: { status: 'restart' },
      role: 'alert',
      message: (locale) => m.discovery_restart({}, options(locale)),
      action: (locale) => m.discovery_restart_action({}, options(locale)),
    },
    {
      state: { status: 'unavailable' },
      role: 'alert',
      message: (locale) => m.search_failed({}, options(locale)),
      action: (locale) => m.search_facet_retry({}, options(locale)),
    },
  ];

  for (const [locale, ambient] of regions) {
    for (const sample of cases) {
      const html = withAmbient(ambient, () => {
        expect(getLocale()).toBe(ambient);
        return render(sample.state, locale);
      });
      expect(html).toContain(`role="${sample.role}"`);
      expect(html.includes('aria-busy="true"')).toBe(sample.busy === true);
      expect(html).toContain(sample.message(locale));
      expect(html).not.toContain(sample.message(ambient));
      if (sample.action) {
        expect(html).toContain(`>${sample.action(locale)}</a>`);
        expect(html).toContain(`href="${restartHref}"`);
        expect(html).not.toContain(`>${sample.action(ambient)}</a>`);
      } else expect(html).not.toContain(`href="${restartHref}"`);
    }
  }

  const both = withAmbient('ja', () => together({ status: 'restart' }));
  expect(both).toContain(m.discovery_restart({}, options('en')));
  expect(both).toContain(m.discovery_restart({}, options('zh-Hans')));
  expect(both).toContain(m.discovery_restart_action({}, options('en')));
  expect(both).toContain(m.discovery_restart_action({}, options('zh-Hans')));
  expect(both).not.toContain(m.discovery_restart({}, options('ja')));
  expect(both.match(new RegExp(`href="${restartHref.replaceAll('?', '\\?')}"`, 'g'))).toHaveLength(2);
  expect(getLocale()).toBe(original);
});
