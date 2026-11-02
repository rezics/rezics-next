import { expect, test } from 'bun:test';
import { GLOBAL, QUESTION, type PublicFigure } from '../src/features/pages/subject-ratings';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { parseDiscoveryPage, parseLegacySearchPage } from '../src/search/discovery';
import { readSearchOutcome } from '../src/search/search-recovery';

const subjectHit = discoveryExample.hits.find((hit) => hit.summary.kind === 'subject');
if (!subjectHit || subjectHit.summary.kind !== 'subject') throw new Error('Missing subject fixture');

function figure(overrides: Partial<PublicFigure> = {}): PublicFigure {
  return {
    questionId: QUESTION,
    populationId: GLOBAL,
    scale: { min: 0, max: 20, displayStep: 1 },
    count: 12,
    state: 'ready',
    mean: 8,
    score: 7.8,
    ...overrides,
  };
}

function legacyPage(rating?: unknown) {
  return {
    subjects: [
      {
        id: subjectHit.key.id,
        type: subjectHit.key.kind,
        labels: { en: 'Subject' },
        summary: null,
        ...(rating === undefined ? {} : { figure: rating }),
      },
    ],
    next: null,
    as_of: discoveryExample.as_of,
  };
}

function mixedPage(rating?: unknown) {
  return {
    ...discoveryExample,
    hits: [{ ...subjectHit, ...(rating === undefined ? {} : { figure: rating }) }],
  };
}

test('legacy and mixed pages admit only native public rating figures without changing valid states', async () => {
  const valid = [
    figure(),
    figure({ mean: null, score: null }),
    figure({ count: 2, state: 'insufficient_data', mean: null, score: null }),
    figure({ count: 0, state: 'insufficient_data', mean: null, score: null }),
    figure({ count: 2, state: 'updating', mean: null, score: null }),
  ];
  for (const rating of valid) {
    expect(parseLegacySearchPage(legacyPage(rating))?.subjects[0]?.figure).toEqual(rating);
    expect(parseDiscoveryPage(mixedPage(rating))?.hits[0]?.figure).toEqual(rating);
  }
  expect(parseLegacySearchPage(legacyPage())).toBeDefined();
  expect(parseDiscoveryPage(mixedPage())).toBeDefined();

  const malformed = [
    figure({ questionId: '00000000-0000-7000-8000-000000000002' }),
    figure({ populationId: '00000000-0000-8000-8000-000000000001' }),
    figure({ scale: { min: 0.5, max: 20, displayStep: 1 } }),
    figure({ scale: { min: 0, max: 20, displayStep: 0 } }),
    figure({ count: 1.5 }),
    figure({ count: Number.MAX_SAFE_INTEGER + 1 }),
    figure({ mean: 10.1 }),
    figure({ score: -0.1 }),
  ];
  for (const rating of malformed) {
    expect(parseLegacySearchPage(legacyPage(rating))).toBeUndefined();
    expect(parseDiscoveryPage(mixedPage(rating))).toBeUndefined();
  }

  for (const [request, invalid, validPage] of [
    [{}, legacyPage(malformed[1]), legacyPage(valid[0])],
    [{ representation: 'discovery-v1' }, mixedPage(malformed[1]), mixedPage(valid[0])],
  ] as const) {
    let reads = 0;
    const send = async () => ({ status: 200, data: ++reads === 1 ? invalid : validPage });
    expect((await readSearchOutcome(request, send)).recovery).toEqual({ status: 'unavailable' });
    expect(reads).toBe(1);
    expect((await readSearchOutcome(request, send)).recovery).toEqual({ status: 'ready' });
    expect(reads).toBe(2);
  }
});
