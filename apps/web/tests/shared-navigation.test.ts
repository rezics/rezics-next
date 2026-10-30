import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNavigation, resolveNavigation, type NavigationContribution } from '../src/shell/navigation';
import { NavigationLinks, NavigationProvider } from '../src/shell/navigation-view';
import { FeatureSlotsProvider } from '../src/shell/feature-slots';
import { useSubjectPurchaseContext, type SubjectPurchaseContext } from '../src/features/pages/subject-slots';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { exposureQuery, sessionQuery } from '../src/session/query';

const context = { locale: 'ja' as const, pathname: '/ja/catalogue/items' };
const leaf: NavigationContribution = {
  id: 'catalogue.browse',
  kind: 'navigation',
  group: 'primary',
  order: 30,
  label: ({ locale }) => `Catalogue (${locale})`,
  href: '/catalogue',
  match: 'prefix',
};
const creation: NavigationContribution = {
  id: 'catalogue.create',
  kind: 'creation',
  group: 'create',
  order: 10,
  label: 'Create collection',
  signedIn: true,
  operation: 'collection.create',
  href: ({ pathname }) => (pathname.startsWith('/catalogue') ? '/collections/new' : null),
};
const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};

test('journey owners contribute ordered leaves and contextual creation entries through one immutable interface', () => {
  const input = [creation, leaf];
  const entries = createNavigation(input);
  input.length = 0;
  expect(Object.isFrozen(entries)).toBe(true);
  expect(Object.isFrozen(entries[0])).toBe(true);
  expect(resolveNavigation(entries, context).map(({ id, href, current }) => ({ id, href, current }))).toEqual([
    { id: leaf.id, href: '/ja/catalogue', current: true },
    { id: creation.id, href: '/ja/collections/new', current: false },
  ]);
  expect(resolveNavigation(entries, { locale: 'en', pathname: '/search' }).map(({ id }) => id)).toEqual([leaf.id]);
  expect(resolveNavigation(entries, { locale: 'en', pathname: '/catalogues' })[0]?.current).toBe(false);
  expect(resolveNavigation(entries, { locale: 'en', pathname: '/catalogue/' })[0]?.current).toBe(true);
});

test('duplicate ids and duplicate leaf destinations cannot be registered, including built-in destinations', () => {
  expect(() => createNavigation([leaf, leaf])).toThrow('Duplicate navigation id');
  expect(() => resolveNavigation(createNavigation([leaf, { ...leaf, id: 'other' }]), context)).toThrow(
    'Duplicate navigation destination',
  );
  expect(() =>
    renderToString(
      createElement(NavigationProvider, { contributions: [{ ...leaf, id: 'shell.home' }], children: null }),
    ),
  ).toThrow('Duplicate navigation id');
});

test('navigation accepts local leaf links and plain labels, with exact matching and locale-safe query links', () => {
  const entries = createNavigation([
    { ...leaf, label: '<em>Catalogue</em>', href: '/catalogue?view=all#items', match: 'exact' },
  ]);
  const [entry] = resolveNavigation(entries, { locale: 'en', pathname: '/en/catalogue' });
  expect(entry?.href).toBe('/en/catalogue?view=all#items');
  expect(entry?.current).toBe(true);
  for (const href of ['//elsewhere.test', '/\\elsewhere.test', '/bad\npath']) {
    expect(() => resolveNavigation(createNavigation([{ ...leaf, href: href as `/${string}` }]), context)).toThrow(
      'local path',
    );
  }
  const html = renderToString(
    createElement(NavigationProvider, {
      contributions: entries,
      children: createElement(NavigationLinks, { context, session: 'unknown', label: 'Navigation' }),
    }),
  );
  expect(html).toContain('&lt;em&gt;Catalogue&lt;/em&gt;');
  expect(html).not.toContain('<em>');
});

test('public leaves and existing defaults render usable SSR anchors while private and gated entries remain closed', () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'private-csrf' });
  client.setQueryData(exposureQuery.queryKey, [
    'personal_library',
    'purchases',
    'collections',
    'library_entry.restore',
  ]);
  const navigation = createElement(NavigationProvider, {
    contributions: [
      leaf,
      creation,
      {
        ...leaf,
        id: 'catalogue.private',
        group: 'personal',
        href: '/private',
        label: 'Private entry',
        signedIn: true,
      },
      { ...leaf, id: 'catalogue.gated', href: '/restore', label: 'Gated entry', operation: 'library_entry.restore' },
    ],
    children: createElement(NavigationLinks, { context, session: 'signed-in', label: 'Navigation' }),
  });
  const html = renderToString(createElement(QueryClientProvider, { client, children: navigation }));
  expect(html).toContain('href="/ja"');
  expect(html).toContain('href="/ja/search"');
  expect(html).toContain('href="/ja/catalogue" aria-current="page"');
  for (const hidden of ['/collections/new', '/private', '/restore', '/library', '/orders'])
    expect(html).not.toContain(`href="/ja${hidden}"`);
  expect(html).not.toContain('private-csrf');
  // A nested provider is an isolated configuration, never a mutable process registry.
  const separate = renderToString(createElement(NavigationLinks, { context, session: 'unknown', label: 'Navigation' }));
  expect(separate).not.toContain('/catalogue');
});

test('the subject purchase named slot is empty by default and mounts an owner region once in the actual subject header', () => {
  const page = structuredClone(recordedPage) as unknown as SubjectPageData;
  const subject = createElement(SubjectPage, { page, locale: 'ja', messages, renderJsonLd: false });
  expect(renderToString(subject)).not.toContain('data-slot="subject-purchase"');
  let received: SubjectPurchaseContext | null = null;
  function PublicEntry(props: SubjectPurchaseContext) {
    received = useSubjectPurchaseContext();
    expect(received).toEqual(props);
    return createElement('a', { href: `/ja/subjects/${props.subjectId}/sources` }, 'Owner entry');
  }
  let privateMounted = false;
  function PrivateEntry() {
    privateMounted = true;
    return createElement('span', null, 'Private benefit');
  }
  const html = renderToString(
    createElement(FeatureSlotsProvider, {
      subjectPurchase: { publicRegion: PublicEntry, privateRegion: PrivateEntry },
      children: subject,
    }),
  );
  const body = recordedPage.reads.r0.body.subject;
  expect(received).toEqual({ subjectId: body.id, subjectType: body.type, locale: 'ja' });
  expect(html.split('data-slot="subject-purchase"')).toHaveLength(2);
  expect(html.indexOf('data-slot="subject-purchase"')).toBeGreaterThan(html.indexOf('<h1'));
  expect(html.indexOf('data-slot="subject-purchase"')).toBeLessThan(html.indexOf('data-slot="subject-summary"'));
  expect(html).toContain('Owner entry');
  expect(privateMounted).toBe(false);
  expect(html).not.toContain('Private benefit');
  expect(renderToString(subject)).not.toContain('Owner entry');
});
