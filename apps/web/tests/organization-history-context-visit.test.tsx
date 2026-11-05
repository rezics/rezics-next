import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OrganizationFact } from '../src/features/catalogue/organization-reader';
import { organizationHistoryVisitReturn, subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { subjectHref } from '../src/subject/subject-href';
import { peopleOrganizationId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { OrganizationReader } = await import('../src/features/catalogue/organization-reader/view');

const context = '00000000-0000-4000-8000-00000000d811';
const realm = '00000000-0000-4000-8000-00000000d812';
const parent = '00000000-0000-4000-8000-00000000d813';
const original = '00000000-0000-4000-8000-00000000d814';
const repeated = '00000000-0000-4000-8000-00000000d815';

function reading() {
  const { release, organization } = peopleProfileFixture('ready', 'en', 'organization');
  organization.subject.context = context;
  organization.related[parent] = { type: 'schema:Organization', labels: { en: 'Earlier Studio' } };
  const fact = (id: string, year: string, revision: number): OrganizationFact => ({
    id,
    rank: 'normal',
    property: { id: 'wdt:P749', data_type: 'wikibase-item' },
    value: { type: 'value', content: parent },
    qualifiers: [
      {
        property: { id: 'schema:startDate', data_type: 'time' },
        value: {
          type: 'value',
          content: {
            time: `+${year}-00-00T00:00:00Z`,
            precision: 9,
            calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
          },
        },
      },
    ],
    references: [
      {
        hash: `source-${year}`,
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: `https://example.org/history/${year}` },
          },
        ],
      },
    ],
    rezics: { release: organization.subject.release, revision },
  });
  const first = fact(original, '1999', 1);
  const second = fact(repeated, '2021', 2);
  organization.subject.statements['wdt:P749'] = [first, second];
  return { release, organization, first, second };
}

test('a selected Context and exact dated Organization assertion survive target, correction and return', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const { createRoot } = await import('react-dom/client');
  const window = new Window({ url: 'https://site.test/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const { release, organization, second } = reading();
  const page = new URL(subjectHref({ id: peopleOrganizationId, label: 'Paper Lantern Studio' }, 'en').href, 'https://site.test');
  page.searchParams.set('realm', realm);
  window.history.replaceState(window.history.state, '', `${page.pathname}${page.search}`);
  const render = async (key: string, current = organization, source: object = {}, navigate = false) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <OrganizationReader
            key={key}
            read={{ public: current, release }}
            source={source}
            locale="en"
            realm={realm}
            currentHref={`${page.pathname}${page.search}`}
          />
        </QueryClientProvider>,
      );
      if (navigate) window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
  try {
    await render('initial');
    const opener = host.querySelector<HTMLButtonElement>(
      `button[data-organization-property="wdt:P749"][data-organization-candidate="${second.id}"]`,
    )!;
    await act(async () => opener.click());
    const inspection = host.querySelector('[role="region"]')!;
    expect(inspection.textContent).toContain(second.id);
    expect(inspection.textContent).toContain('2021');
    const targetLink = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.href.includes(parent))!;
    const target = new URL(targetLink.href);
    expect(target.searchParams.get('context')).toBe(context);
    expect(target.searchParams.get('realm')).toBe(realm);
    const via = target.searchParams.get('via')!;
    const locator = organizationHistoryVisitReturn(new URL(subjectVisitReturn(via, 'en')!, 'https://site.test').hash)!;
    expect(locator).toMatchObject({
      holder: peopleOrganizationId,
      context,
      locale: 'en',
      realm,
      property: 'wdt:P749',
      candidate: second.id,
      revision: 2,
      release: organization.subject.release,
      focus: 'keyboard',
    });
    const correction = inspection.querySelector<HTMLAnchorElement>('a[href*="statement="]')!;
    const correctionAddress = new URL(correction.href);
    expect(correctionAddress.searchParams.get('statement')).toBe(second.id);
    expect(correctionAddress.searchParams.get('context')).toBe(context);
    expect(correctionAddress.searchParams.get('realm')).toBe(realm);
    expect(organizationHistoryVisitReturn(new URL(correctionAddress.searchParams.get('via')!, 'https://site.test').hash)).toMatchObject({
      candidate: second.id,
      context,
    });

    window.history.replaceState(window.history.state, '', via);
    await render('initial', structuredClone(organization), {}, true);
    const returned = host.querySelector('[role="region"]')!;
    expect(returned.textContent).toContain(second.id);
    expect(window.document.activeElement).toBe(returned);

    const hidden = structuredClone(organization);
    hidden.subject.statements['wdt:P749']![1]!.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+2', unit: '1' } },
    });
    await render('initial', hidden, {});
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(host.textContent).toContain(m.organization_reader_changed());
    const concealedRow = [...host.querySelectorAll('li')].find((row) => row.querySelector('button[aria-expanded="false"]'))!;
    expect(concealedRow.querySelector('a')).toBeNull();
    expect([...host.querySelectorAll('li')].some((row) => row !== concealedRow && row.querySelector(`a[href*="${parent}"]`))).toBe(true);
    expect(window.document.activeElement).toBe(host.querySelector('h3'));

    const replaced = structuredClone(organization);
    replaced.subject.statements['wdt:P749']![1] = { ...second, id: '00000000-0000-4000-8000-00000000d816' };
    await render('initial', replaced, {});
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(host.textContent).toContain(m.organization_reader_changed());
    expect(window.document.activeElement).toBe(host.querySelector('h3'));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
