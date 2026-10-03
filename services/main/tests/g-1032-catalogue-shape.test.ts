import { expect, test } from 'bun:test';
import {
  QUERY_CATALOGUE_SCALES,
  queryCatalogueTopics,
} from '../../../scripts/load/corpus-query.ts';

test('G1032: catalogue scales keep dense, intersecting and long-tail Concept populations', () => {
  for (const { works, vocabulary } of QUERY_CATALOGUE_SCALES) {
    const counts = new Map<number, number>();
    let intersect = 0,
      surviving = 0;
    for (let index = 0; index < works; index++) {
      const topics = queryCatalogueTopics(index, vocabulary);
      for (const topic of topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
      if (topics.includes(0) && topics.includes(1)) intersect++;
      if (!topics.includes(0)) surviving++;
    }
    expect(counts.get(0)).toBe(works * 0.9);
    expect(counts.get(1)).toBe(works * 0.5);
    expect(intersect).toBe(works * 0.4);
    expect(surviving).toBe(works * 0.1);
    expect(counts.size).toBeGreaterThan(vocabulary * 0.95);
    expect(
      Math.max(...[...counts].filter(([topic]) => topic >= 4).map(([, count]) => count)),
    ).toBeLessThan(works * 0.05);
  }
});
