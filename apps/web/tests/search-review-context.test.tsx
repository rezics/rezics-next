import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { parseDiscoveryPage, readDiscovery, type DiscoveryPage } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';

const ids = ['00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000912'];
const questionId = '00000000-0000-7000-8000-000000000001';
function page(): DiscoveryPage {
  return {
    ...structuredClone(discoveryExample),
    hits: ids.map((id, index) => ({
      key: { owner: 'content', kind: 'review', route: 0, id },
      summary: {
        kind: 'review',
        value: {
          id,
          kind: 'review',
          title: 'A published review',
          excerpt: 'A spoiler observation.',
          author: { displayName: 'Reader', handle: null },
          source: { openingRevisionId: id, sourceVersion: 'native-version' },
          reviewContext: {
            state: 'available',
            openingPostId: id,
            language: 'en',
            spoiler: true,
            target: {
              state: 'available',
              subject: {
                id,
                type: index ? 'schema:Movie' : 'schema:Book',
                types: [index ? 'schema:Movie' : 'schema:Book'],
                label: { value: 'Same title', language: 'en' },
                creativeWork: true,
                cover: null,
              },
            },
            citation: {
              state: 'available',
              recorded: { questionId, units: index ? 7 : 0, revision: 3 },
              historicalQuestion: { state: 'unavailable' },
            },
          },
        },
      },
    })),
    next: 'native-sparse-continuation',
  };
}

test('the real Search receiver admits historical zero and target identity into mounted mixed cards with one request', async () => {
  const calls: string[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (input) => {
      calls.push(String(input));
      return Response.json(page());
    },
  });
  const { discovery } = await readDiscovery({ representation: 'discovery-v1', limit: 20, languages: ['en'] }, (body) =>
    client.subjects.$search.post(body),
  );
  expect(discovery.status).toBe('ready');
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { state: discovery, locale: 'en' }));
  expect(calls).toEqual(['http://kernel.local/v1/subjects:search']);
  expect(html.match(/data-discovery-review=/g)).toHaveLength(2);
  for (const id of ids) expect(html).toContain(`/en/subjects/${id}/same-title`);
  expect(html).toContain('schema:Movie');
  expect(html).toContain('schema:Book');
  expect(html).toContain('0 units');
  expect(html).toContain(questionId);
  expect(html).toContain('revision 3');
  expect(html).toContain('historical question label and scale are unavailable');
  expect(html).toContain('<details');
  expect(html).not.toContain('Your current vote');
  expect(html).not.toContain('button');
  if (discovery.status === 'ready') expect(discovery.page.next).toBe('native-sparse-continuation');
});

test('missing, erased and withheld citations stay distinct and never display a guessed zero or stale target', () => {
  for (const state of ['absent', 'unsupported', 'unavailable', 'withdrawn', 'erased', 'withheld'] as const) {
    const wire = page();
    const hit = wire.hits[0]!;
    if (hit.summary.kind !== 'review') throw new Error('Expected review');
    delete hit.summary.value.author;
    hit.summary.value.reviewContext = {
      state: 'available',
      openingPostId: ids[0]!,
      language: null,
      spoiler: false,
      target: { state: 'withheld' },
      citation: { state },
    };
    wire.hits = [hit];
    const admitted = parseDiscoveryPage(wire);
    expect(admitted).toBeDefined();
    const html = renderToStaticMarkup(
      createElement(DiscoveryResults, { state: { status: 'ready', page: admitted! }, locale: 'en' }),
    );
    expect(html).not.toContain('0 units');
    expect(html).not.toContain('Same title');
    expect(html).not.toContain(`/en/subjects/${ids[0]}`);
    expect(html).not.toContain('Reader');
    expect(html).not.toContain(questionId);
  }
});

test('closed receiving refuses stale target siblings, current-label substitution, private votes and oversized context', () => {
  const original = page();
  for (const mutate of [
    (value: any) => {
      value.reviewContext.target = { state: 'withheld' };
    },
    (value: any) => {
      value.reviewContext.citation.historicalQuestion = { state: 'available', label: 'Today’s question', revision: 99 };
    },
    (value: any) => {
      value.reviewContext.currentVote = { units: 19 };
    },
    (value: any) => {
      value.reviewContext.target.subject.label.value = 'x'.repeat(1025);
    },
    (value: any) => {
      delete value.source;
    },
  ]) {
    const wire = structuredClone(original);
    const hit = wire.hits[0]!;
    if (hit.summary.kind !== 'review') throw new Error('Expected review');
    mutate(hit.summary.value);
    expect(parseDiscoveryPage(wire)).toBeUndefined();
  }
  const wire = page();
  const hit = wire.hits[0]!;
  if (hit.summary.kind !== 'review') throw new Error('Expected review');
  hit.summary.value.subject = { id: ids[1]!, title: 'Old disclosed title' };
  expect(parseDiscoveryPage(wire)).toBeUndefined();
});

// An unavailable assembly cannot inherit an earlier opening's spoiler state.
test('unavailable current context suppresses an earlier opening excerpt', () => {
  const wire = page();
  const hit = wire.hits[0]!;
  if (hit.summary.kind !== 'review') throw new Error('Expected review');
  hit.summary.value.reviewContext = { state: 'unavailable' };
  wire.hits = [hit];
  const admitted = parseDiscoveryPage(wire);
  expect(admitted).toBeDefined();
  const html = renderToStaticMarkup(createElement(DiscoveryResults, {
    state: { status: 'ready', page: admitted! }, locale: 'en',
  }));
  expect(html).not.toContain('A spoiler observation.');
  expect(html).not.toContain('0 units');
});
