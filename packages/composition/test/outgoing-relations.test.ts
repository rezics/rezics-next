import { expect, test } from 'bun:test';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  readCost,
  validateComposition,
  type CompositionDocument,
} from '../src/index';
const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e92';
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'OutgoingRelations', props: { id: 'editions', property: 'schema:workExample', limit: 24, paged: true } },
    { type: 'Credits', props: { id: 'cast', property: 'wdt:P725', direction: 'forward', limit: 24, paged: true } },
    { type: 'RelationGroups', props: { id: 'adaptations', property: 'schema:exampleOfWork', limit: 24, paged: true } },
  ],
};
test('outgoing descriptors are inert bounded native reads with separate group cursors and current Context', () => {
  expect(validateComposition(platformRegistry, document)).toEqual([]);
  const context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
  const first = planReads(platformRegistry, document, { subject, context });
  expect(Object.values(first.reads).map((read) => [read.kind, readCost(read)])).toEqual([
    ['relations', 12],
    ['relations', 12],
    ['links', 12],
  ]);
  expect(Object.keys(first.reads).length).toBeLessThanOrEqual(MAX_PAGE_READS);
  expect(Object.values(first.reads).reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(MAX_PAGE_COST);
  const continued = planReads(platformRegistry, document, {
    subject,
    context,
    continuation: { node: 'cast', cursor: 'cast-next' },
  });
  expect(continued.reads[continued.nodes.cast!]).toMatchObject({
    kind: 'relations',
    context: PAGE_GLOBAL_CONTEXT,
    property: 'wdt:P725',
    cursor: 'cast-next',
    limit: 12,
  });
  expect(Object.values(continued.reads).filter((read) => 'cursor' in read)).toHaveLength(1);
  expect(() =>
    planReads(platformRegistry, document, { subject, continuation: { node: 'missing', cursor: 'x' } }),
  ).toThrow();
});
