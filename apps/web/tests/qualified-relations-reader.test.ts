import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry } from '@rezics/composition';

import {
  qualifiedRelationsPage,
  qualifiedStatement,
  qualifiedSubject,
  qualifiedRealm,
} from '../src/kernel/fake/qualified-relations';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';

// Supply the Worker environment boundary; native read planning, SDK calls and rendering remain real.
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { SubjectPage, pageContext } = await import('../src/features/pages/subject');
const { holderItems } = await import('../src/features/pages/overview');
const { qualifiedNotes } = await import('../src/features/pages/qualified-relations');
const { readRelationGroup, relationGroupKey } = await import('../src/features/pages/relation-stream-query');
const { relationPreviewCount } = await import('../src/features/pages/subject-relations-preview');

function render(page = qualifiedRelationsPage(), spoilerLevel: 0 | 1 | 2 = 0) {
  return renderToString(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(SubjectPage, {
        page,
        locale: 'en',
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Unlabelled',
          sources: 'Sources',
          aliases: 'Also known as',
          spoilerShow: 'Show spoiler',
        },
        reader: { spoilerLevel, suitability: 'blur' },
        renderJsonLd: false,
      }),
    }),
  );
}

test('Qualified credits characters spoilers and complete group continuation are visible in the real subject reader', () => {
  const html = render();
  expect(html).toContain('Ada Player');
  expect(html).toContain('Credited as: A. Player');
  expect(html).toContain('Order: 1');
  expect(html).toContain('Role: Voice');
  expect(html).toContain('Character: The Traveller');
  expect(html).toMatch(/href="\/en\/subjects\/[^\"]+\/voice"/);
  expect(html).toMatch(/href="\/en\/subjects\/[^\"]+\/the-traveller"/);
  expect(html).toContain('First editions 12');
  expect(html).toContain('First adaptations 12');
  expect(html).not.toContain('First editions 13');
  expect(html).toContain('node=editions');
  expect(html).toContain('cursor=editions-next');
  expect(html).toContain('node=adaptations');
  expect(html).not.toContain('data-slot="count"');
  expect(relationPreviewCount({ relationCounts: {} }, 'schema:character')).toBeUndefined();
});

test('qualified rows preserve unknown values and quantity bounds, retain unavailable categories, and gate the whole spoiler row', () => {
  const snak = (property: string, type: string, content: unknown) => ({
    property: { id: property, data_type: type },
    value: { type: 'value', content },
  });
  const first = qualifiedStatement('one', 'wdt:P725', qualifiedSubject.id, [
    snak('wdt:P1932', 'string', 'First name'),
    snak('wdt:P3831', 'wikibase-item', 'hidden-role'),
    snak('schema:position', 'quantity', {
      amount: '+2',
      unit: 'http://www.wikidata.org/entity/Q7727',
      lowerBound: '+1',
      upperBound: '+3',
    }),
  ]);
  const second = qualifiedStatement('two', 'wdt:P725', qualifiedSubject.id, [
    snak('wdt:P1932', 'string', 'Second name'),
  ]);
  const rows = holderItems(
    {
      links: [
        { subject: qualifiedSubject.id, statement: 'one', label: 'Person', assertion: first, related: {} },
        { subject: qualifiedSubject.id, statement: 'two', label: 'Person', assertion: second, related: {} },
      ],
      next: null,
    },
    12,
  )!;
  expect(rows.items.map((item) => item.qualified?.map((note) => note.text))).toEqual([
    ['Credited as: First name', 'Role: Unlabelled subject', 'Order:'],
    ['Credited as: Second name'],
  ]);
  expect(rows.items[0]!.qualified?.[1]).toEqual({ property: 'wdt:P3831', text: 'Role: Unlabelled subject' });
  expect(rows.items[0]!.qualified![1]!.subject).toBeUndefined();
  expect(rows.items[0]!.qualified?.[2]!.quantity?.content).toEqual({
    amount: '+2',
    unit: 'http://www.wikidata.org/entity/Q7727',
    lowerBound: '+1',
    upperBound: '+3',
  });
  const customUnit = 'https://example.test/unit';
  const measured = qualifiedStatement('measured', 'wdt:P725', qualifiedSubject.id, [
    snak('schema:position', 'quantity', { amount: '+2', unit: customUnit }),
  ]);
  const disclosedUnit = {
    [customUnit]: { id: customUnit, type: 'skos:Concept', label: { value: 'measures', language: 'en' } },
  };
  expect(qualifiedNotes(measured, disclosedUnit, 'en')[0]!.quantity?.presentation.unitLabel).toBe('measures');
  expect(qualifiedNotes(measured, {}, 'en')[0]!.quantity?.presentation.unitLabel).toBeNull();
  const unknowns = qualifiedStatement('unknowns', 'wdt:P725', qualifiedSubject.id, [
    { property: { id: 'wdt:P3831', data_type: 'wikibase-item' }, value: { type: 'somevalue' } },
    { property: { id: 'wdt:P453', data_type: 'wikibase-item' }, value: { type: 'novalue' } },
  ]);
  expect(qualifiedNotes(unknowns, {}, 'en').map((note) => note.text)).toEqual([
    'Role: Unknown value',
    'Character: No value',
  ]);
  expect(qualifiedNotes(qualifiedStatement('empty', 'wdt:P725', qualifiedSubject.id), {}, 'en')).toEqual([]);
  const page = qualifiedRelationsPage();
  const plan = planReads(platformRegistry, page.document, pageContext(page));
  const body = page.reads[plan.nodes.cast!]!.body as {
    relations: { statement: { qualifiers: unknown[] }; label: string }[];
  };
  body.relations[0]!.statement.qualifiers.push(snak('wdt:P3831', 'wikibase-item', 'hidden-role'));
  const unavailable = render(page);
  expect(unavailable).toContain('<span>Role: Unlabelled subject</span>');
  expect(unavailable).not.toContain('hidden-role');
  body.relations[0]!.statement.qualifiers.push(
    snak('schema:position', 'quantity', {
      amount: '+2',
      unit: 'http://www.wikidata.org/entity/Q7727',
      lowerBound: '+1',
      upperBound: '+3',
    }),
  );
  body.relations[0]!.statement.qualifiers.push(snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' }));
  body.relations[0]!.label = 'Secret performer';
  expect(render(page)).not.toContain('Secret performer');
  expect(render(page)).not.toContain('A. Player');
  expect(render(page)).toContain('Show spoiler');
  expect(render(page, 2)).toContain('Secret performer');
  expect(render(page, 2)).toContain('Order: +2 (≥ +1; ≤ +3) min');
});

test('More resolves one current group with separate Context keys and retains a retryable owner error', async () => {
  const requests: { path: string; body?: unknown }[] = [];
  const fake = createFakeKernelFetch(fixtures as never);
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        path: new URL(request.url).pathname,
        body: request.method === 'POST' ? await request.clone().json() : undefined,
      });
      return fake(request);
    }) as typeof fetch,
  });
  const request = {
    subject: qualifiedSubject.id,
    locale: 'en',
    view: 'relations' as const,
    node: 'editions',
    cursor: 'editions-next',
    realm: qualifiedRealm,
  };
  const next = await readRelationGroup(client, request, 'Bearer current-reader');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toMatchObject({
    target: { subject: qualifiedSubject.id, realm: qualifiedRealm, view: 'relations' },
    continuation: { node: 'editions', cursor: 'editions-next' },
  });
  expect(next).toMatchObject({ ok: true });
  expect(next.ok && next.body.next).toBeNull();
  expect(next.ok && (next.body.relations as unknown[]).length).toBe(2);
  expect(relationGroupKey(request)).not.toEqual(relationGroupKey({ ...request, node: 'adaptations' }));
  expect(relationGroupKey(request)).not.toEqual(relationGroupKey({ ...request, realm: undefined }));
  expect(await readRelationGroup(client, { ...request, node: 'cast', cursor: 'refuse' })).toEqual({
    ok: false,
    status: 409,
  });
  const html = render(
    qualifiedRelationsPage({ continuation: { node: 'cast', cursor: 'refuse' }, realm: qualifiedRealm, error: 409 }),
  );
  expect(html).toContain('Start again');
  expect(html).toContain(`realm=${qualifiedRealm}`);
});
