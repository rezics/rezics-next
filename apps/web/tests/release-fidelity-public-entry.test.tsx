import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/subject-page.json';
import type { SubjectPageData } from '../src/features/pages/subject';
import { candidateContext } from '../src/subject/candidates';
import { subjectHref } from '../src/subject/subject-href';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectFrame, subjectFrame } = await import('../src/features/pages/subject-frame');
const { ReleaseFidelityEntry } = await import('../src/features/catalogue/release-fidelity/entry');
const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
const { catalogueEntries, contributionHref } = await import('../src/features/catalogue/catalogue-entry');
const { viewTabLabels } = await import('../src/features/pages/route-support');
const { Route } = await import('../src/routes/subjects/$id_.$slug_.release');

const id = '00000000-0000-4000-8000-000000000101';
const label = 'A published edition';
const selectedContext = '00000000-0000-4000-8000-000000000202';
const base = subjectHref({ id, label }, 'en').href;
const frame = {
  ...subjectFrame(recording as unknown as SubjectPageData, 'en')!,
  id,
  type: 'bf:Instance',
  context: selectedContext,
  title: { text: label, lang: 'en' },
};
const validator = Route.options.validateSearch as (input: Record<string, unknown>) => Record<string, unknown>;

async function mountedFrame(context = selectedContext, realm?: string) {
  const current = { ...frame, context };
  const route = createRootRoute({
    component: () => (
      <SubjectFrame
        frame={current}
        locale="en"
        unlabelled="Untitled"
        tabs={[]}
        tabLabels={viewTabLabels()}
        view="overview"
        {...(realm ? { realm } : {})}
      />
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: [`${base}?context=${context}`] }),
  });
  await router.load();
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test('SubjectFrame, editorial collection and the installed release route retain the observed Context and one compatible origin', async () => {
  const origin = subjectVisitReturn(`${base}?context=${selectedContext}`, 'en')!;
  const props: ComponentProps<typeof ReleaseFidelityEntry> = {
    id,
    type: 'bf:Instance',
    label,
    locale: 'en',
    context: selectedContext,
    returnHref: origin,
  };
  const collected = collectEditorialEntries(createElement(ReleaseFidelityEntry, props)).entries[0]!;
  const direct = renderToStaticMarkup(createElement(ReleaseFidelityEntry, props));
  const directHref = /href="([^"]+)"/.exec(direct)?.[1]?.replaceAll('&amp;', '&');
  expect(directHref).toBe(collected.href);
  const address = new URL(collected.href, 'https://rezics.invalid');
  expect(address.pathname).toBe(`${base}/release`);
  expect(address.searchParams.get('context')).toBe(selectedContext);
  expect(address.searchParams.get('via')).toBe(origin);
  expect(new TextEncoder().encode(address.href).length).toBeLessThanOrEqual(8192);
  expect(new TextEncoder().encode(origin).length).toBeLessThanOrEqual(8192);
  expect(validator(Object.fromEntries(address.searchParams))).toMatchObject({ context: selectedContext, via: origin });
  expect(new URL(contributionHref(collected, true), 'https://rezics.invalid').searchParams.get('return_to')).toBe(
    collected.href,
  );
  const mounted = (await mountedFrame()).replaceAll('&amp;', '&');
  expect(mounted).toContain('data-slot="subject-contribute"');
  expect(mounted).toContain(collected.href);
  expect(
    (await mountedFrame(selectedContext, '00000000-0000-4000-8000-000000000303')).includes('subject-contribute'),
  ).toBe(false);
});

test('Global, legacy, malformed and unavailable-origin entries keep their route meaning and eligibility', () => {
  const global = catalogueEntries.releaseFidelity({
    id,
    type: 'bf:Instance',
    label,
    locale: 'en',
    context: candidateContext,
  })!;
  const legacy = catalogueEntries.releaseFidelity({ id, type: 'bf:Instance', label, locale: 'en' })!;
  expect(new URL(global.href, 'https://rezics.invalid').searchParams.get('context')).toBe(candidateContext);
  expect(new URL(legacy.href, 'https://rezics.invalid').searchParams.has('context')).toBe(false);
  expect(validator({}).context).toBe(candidateContext);
  expect(() =>
    catalogueEntries.releaseFidelity({ id, type: 'bf:Instance', label, locale: 'en', context: 'bad' }),
  ).toThrow();
  expect(() => validator({ context: 'bad' })).toThrow();
  expect(catalogueEntries.releaseFidelity({ id, type: 'schema:Book', label, locale: 'en' })).toBeUndefined();
  const unavailable = catalogueEntries.releaseFidelity({
    id,
    type: 'bf:Instance',
    label,
    locale: 'en',
    context: selectedContext,
    returnHref: `https://outside.test${base}?context=${selectedContext}`,
  })!;
  const search = new URL(unavailable.href, 'https://rezics.invalid').searchParams;
  expect(search.get('context')).toBe(selectedContext);
  expect(search.has('via')).toBe(false);
});
