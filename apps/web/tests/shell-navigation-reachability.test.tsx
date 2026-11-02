import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { createNavigation, resolveNavigation, type NavigationSession } from '../src/shell/navigation';
import { threadsNavigation } from '../src/threads/navigation';
import { catalogueNavigation } from '../src/features/catalogue/navigation';
import { importReviewNavigation } from '../src/features/import-review/navigation';
import { communityNavigation } from '../src/community/navigation';
import { libraryNavigation } from '../src/library/navigation';
import { contextsNavigation } from '../src/features/contexts/navigation';
import { zonesNavigation } from '../src/features/zones/manage/navigation';
import { myLogsNavigation } from '../src/library/my-logs';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const exposure = await import('../src/kernel/exposure');
const { NavigationLinks, NavigationProvider, defaultNavigation } = await import('../src/shell/navigation-view');
const { PhoneCreationLinks } = await import('../src/shell/phone-navigation');
afterAll(() => mock.restore());
const owners = {
  threadsNavigation,
  catalogueNavigation,
  importReviewNavigation,
  communityNavigation,
  libraryNavigation,
  contextsNavigation,
  zonesNavigation,
  myLogsNavigation,
};
const contributions = Object.values(owners).flat();
const context = { locale: 'en' as const, pathname: '/en/boards/discussion' };
const targets = [
  '/boards',
  '/my/contexts',
  '/imports/review',
  '/my/zones',
  '/catalogue/new',
  '/realms/new',
  '/collections/new',
  '/my/contexts/new',
  '/my/zones/new',
];
const creationPaths = targets.slice(4);
const privatePaths = ['/my/contexts', '/my/zones', '/my/contexts/new', '/my/zones/new'];
const gates = {
  'provider_review.list': '/imports/review',
  'subject.create': '/catalogue/new',
  'realm.create': '/realms/new',
  collections: '/collections/new',
};

test('root composes every journey owner once, with unique ids and destinations', async () => {
  const root = await Bun.file(new URL('../src/routes/__root.tsx', import.meta.url)).text();
  for (const name of Object.keys(owners)) {
    expect(root.match(new RegExp(`import \\{ ${name} \\}`, 'g'))).toHaveLength(1);
    expect(root.match(new RegExp(`\\.\\.\\.${name}\\b`, 'g'))).toHaveLength(1);
  }
  expect(root).toContain('<AppShell navigation={commerceNavigation}');
  const resolved = resolveNavigation(createNavigation([...defaultNavigation, ...contributions]), context);
  expect(resolved.filter(({ path }) => targets.includes(path)).map(({ path }) => path)).toEqual(targets);
  expect(resolved.find(({ path }) => path === '/boards')?.current).toBe(true);
  expect(resolveNavigation(contributions, { ...context, pathname: '/en/boards-other' })[0]?.current).toBe(false);
});

test('desktop and phone offer the same admitted creation journeys; public boards render without JavaScript', () => {
  let hydrated = false;
  let admitted: string[] | undefined;
  const hydration = spyOn(React, 'useSyncExternalStore').mockImplementation((_, client, server) =>
    hydrated ? client() : server!(),
  );
  const operation = spyOn(exposure, 'useOperation').mockImplementation((id) =>
    exposure.operationIsAdmitted(id, admitted),
  );
  const ui = (session: NavigationSession, phone = false) => (
    <NavigationProvider contributions={contributions}>
      {phone ? (
        <PhoneCreationLinks actions={[]} pathname={context.pathname} session={session} />
      ) : (
        <NavigationLinks context={context} session={session} desktop label="Navigation" />
      )}
    </NavigationProvider>
  );
  const paths = (session: NavigationSession, phone = false) =>
    [...renderToString(ui(session, phone)).matchAll(/href="\/en([^"?]*)"/g)]
      .map((match) => match[1]!)
      .filter((path) => targets.includes(path));
  const assert = (session: NavigationSession, expected: string[]) => {
    expect(paths(session)).toEqual(expected);
    expect(paths(session, true)).toEqual(expected.filter((path) => creationPaths.includes(path)));
  };
  try {
    for (const session of ['unknown', 'signed-out', 'signed-in'] as const) assert(session, ['/boards']);
    expect(renderToString(ui('unknown'))).toContain('href="/en/boards" aria-current="page"');
    hydrated = true;
    admitted = ['provider_review.list', 'subject.create', 'realm.create', 'collections'];
    for (const session of ['unknown', 'signed-out', 'unavailable'] as const) assert(session, ['/boards']);
    admitted = undefined;
    assert('signed-in', ['/boards', ...privatePaths]);
    admitted = [];
    assert('signed-in', ['/boards', ...privatePaths]);
    for (const [id, destination] of Object.entries(gates)) {
      admitted = [id];
      assert(
        'signed-in',
        targets.filter((path) => path === '/boards' || privatePaths.includes(path) || path === destination),
      );
    }
    admitted = Object.keys(gates);
    assert('signed-in', targets);
  } finally {
    hydration.mockRestore();
    operation.mockRestore();
  }
});
