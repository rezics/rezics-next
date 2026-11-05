import { expect, test } from 'bun:test';
import type { KernelRecording } from '../src/kernel/fake.ts';
import { routes } from '../src/kernel/fake/search-facets.ts';
import { requestLanguages } from '../src/kernel/languages.ts';
import definitions from '../src/kernel/recorded/definitions-release.json';
import searchFacets from '../src/kernel/recorded/search-facets.json';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const facetRoute = routes.find((route) => route.method === 'POST' && route.path === '/v1/subjects:facets');
const definitionRecording = definitions as unknown as KernelRecording & {
  release: { types: Record<string, { labels: Record<string, string> }> };
};
const facetsRecording = searchFacets as unknown as KernelRecording & {
  query: string;
  facets: { property: string; values: { value: string }[] }[];
};
const recordings = {
  'definitions-release': definitionRecording,
  'search-facets': facetsRecording,
} satisfies Record<string, KernelRecording>;

test('localized page choices use release labels for each launch locale', async () => {
  const story = facetRoute?.story;
  expect(story, 'the recorded Search facet route exists').toBeDefined();
  const sourceValues = facetsRecording.facets.find((facet) => facet.property === 'type')?.values ?? [];
  const typeIds = sourceValues.map(({ value }) => value);

  for (const locale of locales) {
    const request = new Request('http://kernel.local/v1/subjects:facets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: facetsRecording.query,
        languages: requestLanguages(locale),
        facets: [{ property: 'type', size: 20 }],
      }),
    });
    const response = await story!({ request, recordings, match: null });
    const facet = (
      response?.facets as { property: string; values: { value: string; labels: Record<string, string> }[] }[]
    )?.find((entry) => entry.property === 'type');
    expect(
      facet?.values.map(({ value }) => value),
      `${locale} keeps the recorded type IDs`,
    ).toEqual(typeIds);
    for (const choice of facet?.values ?? []) {
      expect(choice.labels, `${locale} ${choice.value} uses its definitions release label`).toEqual({
        [locale]: definitionRecording.release.types[choice.value]!.labels[locale],
      });
    }
  }
});
