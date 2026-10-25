import { expect, test } from 'bun:test';
import { convertWikidata } from '../src/wikidata';

test('Wikidata returns domain conversion data without intrinsic work instrumentation', () => {
  const record = {
    id: 'Q1',
    type: 'item',
    lastrevid: 1,
    labels: { en: { language: 'en', value: 'Book' } },
    descriptions: {},
    aliases: {},
    claims: {
      P31: [
        {
          type: 'statement',
          rank: 'normal',
          mainsnak: {
            property: 'P31',
            snaktype: 'value',
            datatype: 'wikibase-item',
            datavalue: {
              type: 'wikibase-entityid',
              value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
            },
          },
        },
      ],
    },
  };
  const result = convertWikidata(
    { external_id: 'Q1', record_revision: '1', record },
    { subjectId: '00000000-0000-4000-8000-000000000001' },
  );
  expect(Object.hasOwn(result, 'metrics')).toBe(false);
  expect(result.proposals.length).toBeGreaterThan(0);
  expect(result.normalizedRecord).toBeDefined();
});
