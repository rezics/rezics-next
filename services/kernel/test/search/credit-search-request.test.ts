import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { ProblemError } from '../../src/http/problem.ts';
import { admitDiscoveryRequest, type MixedDiscoveryRequest } from '../../src/search/discovery-request.ts';
import type { DiscoveryRegistry } from '../../src/search/discovery.ts';
import { admitFacetCreditQualifiers, validateFacets } from '../../src/search/facets.ts';
import { facetCursorBinding } from '../../src/search/facet-discovery-runtime.ts';
import { parseText } from '../../src/search/text.ts';

const role = '0196a000-0000-7000-8000-000000000001';
const release = {
  types: {},
  properties: { 'wdt:P3831': { datatype: 'wikibase-item' }, 'schema:name': { datatype: 'text' } },
} as unknown as FilterRelease;
// Filter admission maps registry.entries; text-only requests ignore the directory.
const registry = { entries: [{ owner: 'semantic', kind: 'schema:Book' }] } as unknown as DiscoveryRegistry;
const request = (extra: Partial<MixedDiscoveryRequest>): MixedDiscoveryRequest => ({
  representation: 'discovery-v1',
  text: 'ada',
  ...extra,
});

function refusal(run: () => unknown): ProblemError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error('Expected the request to be refused');
}

test('credited-creator text binds its released same-credit qualifiers', () => {
  const admitted = admitDiscoveryRequest(
    request({ textField: 'credited_creator', creditQualifiers: [{ property: 'wdt:P3831', value: role }] }),
    registry,
    release,
  );
  expect(admitted.textField).toBe('credited_creator');
  expect(admitted.creditQualifiers).toEqual([{ property: 'wdt:P3831', value: role }]);
  expect(admitted.bindingRequest).toMatchObject({
    textField: 'credited_creator',
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
  });
});

test('catalogue text keeps its existing binding shape', () => {
  const admitted = admitDiscoveryRequest(request({}), registry, release);
  expect(admitted.textField).toBeUndefined();
  expect(admitted.bindingRequest).not.toHaveProperty('textField');
  expect(admitted.bindingRequest).not.toHaveProperty('creditQualifiers');
});

test('credited text needs its own text and rejects unreleased or malformed qualifiers', () => {
  const pointer = (run: () => unknown) => refusal(run).errors?.[0]?.pointer;
  expect(
    pointer(() =>
      admitDiscoveryRequest({ representation: 'discovery-v1', textField: 'credited_creator' }, registry, release),
    ),
  ).toBe('/text');
  expect(
    pointer(() =>
      admitDiscoveryRequest(request({ creditQualifiers: [{ property: 'wdt:P3831', value: role }] }), registry, release),
    ),
  ).toBe('/creditQualifiers');
  const credited = (creditQualifiers: unknown) =>
    request({ textField: 'credited_creator', creditQualifiers: creditQualifiers as never });
  expect(
    pointer(() => admitDiscoveryRequest(credited([{ property: 'wdt:Unknown', value: role }]), registry, release)),
  ).toBe('/creditQualifiers/0/property');
  expect(
    pointer(() => admitDiscoveryRequest(credited([{ property: 'wdt:P3831', value: 'writer' }]), registry, release)),
  ).toBe('/creditQualifiers/0/value');
  expect(
    pointer(() =>
      admitDiscoveryRequest(
        credited([
          { property: 'wdt:P3831', value: role },
          { property: 'wdt:P3831', value: role },
        ]),
        registry,
        release,
      ),
    ),
  ).toBe('/creditQualifiers/1');
  // The count pass keeps this exact credited predicate and role in its independent native execution.
  const counted = admitDiscoveryRequest(
    {
      ...request({
        textField: 'credited_creator',
        filter: { and: [{ kind: { in: ['schema:Book'] } }] },
      }),
      kindCountLeaf: 0,
    },
    registry,
    release,
  );
  expect(counted.textField).toBe('credited_creator');
  expect(counted.countFilter).toBeUndefined();
  expect(counted.filter).toEqual({ and: [{ kind: { in: ['schema:Book'] } }] });
});

test('credited facets admit the same released qualifier and bind it with the name text', () => {
  const input = {
    text: 'ada',
    textField: 'credited_creator' as const,
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
    facets: [{ property: 'type' }],
  };
  const facets = validateFacets(input);
  const qualifiers = admitFacetCreditQualifiers(input, release);
  expect(qualifiers).toEqual([{ property: 'wdt:P3831', value: role }]);
  const binding = facetCursorBinding(
    {
      principal: 'anonymous',
      text: parseText(input.text),
      textField: input.textField,
      creditQualifiers: qualifiers ?? [],
      languages: ['en'],
      originalFilter: undefined,
      facets,
      now: 0,
    },
    facets[0]!,
  );
  expect(binding.request).toMatchObject({
    textField: 'credited_creator',
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
    text: parseText('ada'),
  });
});
