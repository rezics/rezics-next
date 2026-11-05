import type { Release } from '../../subject/definitions';
import type { PersonalLibraryEntry } from '../entries-read';
import { prepareShelfWorkContext } from './context';

/** Illustrative native-shaped projection, not a recording or a claim of producer activation. */
export const contextExampleRelease: Release = {
  types: Object.fromEntries(
    ['schema:Book', 'schema:Movie', 'rezics:AnimeRelease'].map((type) => [
      type,
      {
        properties: ['schema:author', 'schema:director', 'schema:datePublished', 'schema:isBasedOn'],
        listPresentation: {
          imageAspect: 'portrait' as const,
          keyFacts: ['schema:author', 'schema:director', 'schema:datePublished', 'schema:isBasedOn'],
        },
      },
    ]),
  ),
  properties: {
    'schema:author': { datatype: 'wikibase-item', labels: { en: 'Author', ja: '著者' } },
    'schema:director': { datatype: 'wikibase-item', labels: { en: 'Director', ja: '監督' } },
    'schema:datePublished': { datatype: 'time', labels: { en: 'Published', ja: '公開日' } },
    'schema:isBasedOn': { datatype: 'wikibase-item', labels: { en: 'Based on', ja: '原作' } },
  },
};
export const shelfExampleId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
export function shelfContextExamples(locale: string): PersonalLibraryEntry[] {
  return ['schema:Book', 'schema:Movie', 'rezics:AnimeRelease', 'schema:Book', null].map((type, index) => {
    const entry: PersonalLibraryEntry = {
      subjectId: shelfExampleId(100 + index),
      revision: 7,
      incarnationId: shelfExampleId(200 + index),
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      state: 'in_progress',
      stateLabel: 'In progress',
      changeKey: shelfExampleId(300 + index),
      removeKey: shelfExampleId(400 + index),
      subject: type
        ? { id: shelfExampleId(100 + index), type, types: [type], label: 'Home', typeLabel: type, cover: null }
        : null,
      activeProgressSession: {
        mode: 'scalar_amount',
        unit: 'page',
        amount: '12',
        total: '100',
        completedUnitCount: 0,
        locator: null,
      },
      ...(index >= 3
        ? {}
        : {
            facts: {
              [index === 0 ? 'schema:author' : 'schema:director']: [
                {
                  kind: 'item',
                  id: shelfExampleId(500 + index),
                  labels: { en: ['Alex Lee', 'Alex Lee', 'Robin Chen'][index]! },
                },
              ],
              'schema:datePublished': [
                {
                  kind: 'time',
                  year: 2020 + index,
                  ...(index ? { month: 5 } : {}),
                  ...(index === 2 ? { day: 3 } : {}),
                },
              ],
              ...(index === 2
                ? { 'schema:isBasedOn': [{ kind: 'item', id: shelfExampleId(100), labels: { en: 'Home' } }] }
                : {}),
            },
          }),
    };
    return { ...entry, workContext: prepareShelfWorkContext(entry, contextExampleRelease, locale) };
  });
}
