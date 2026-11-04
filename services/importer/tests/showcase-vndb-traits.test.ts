import { expect, test } from 'bun:test';
import { emptyCrossMediaPlan, type CrossMediaPort } from '../src/cross-media-seed.ts';
import { prepareShowcaseVndbTraits } from '../src/showcase-vndb-traits.ts';

const scheme = '00000000-0000-4000-8000-000000000010';
const concepts = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
const subjects = Object.fromEntries([
  ['vndb-character-traits-scheme', scheme],
  ...['i23', 'i30'].map((code, index) => [`vndb-character-traits-${code}`, concepts[index]!]),
]);

test('the development trait adapter reuses current reviewed Concepts only for its elected characters', async () => {
  const plan = emptyCrossMediaPlan();
  plan.entities.vndb.push({ source: 'vndb', key: 'c6487', revision: null, payload: { id: 'c6487' } });
  const port = {
    readReviewedSubject: async (id: string) => ({
      subject: {
        id,
        type: id === scheme ? 'skos:ConceptScheme' : 'skos:Concept',
        statements: {
          'schema:url': [
            {
              value: {
                content: `https://rezics.com/schemes/vndb/character-traits${id === scheme ? '' : `/${['i23', 'i30'][concepts.indexOf(id)]}`}`,
              },
            },
          ],
          ...(id === scheme ? {} : { 'skos:inScheme': [{ value: { content: scheme } }] }),
        },
      },
    }),
  } as unknown as CrossMediaPort;
  const tables = {
    async *rows() {
      yield { id: 'c6487', tid: 'i23', spoil: '0', lie: 'f' };
      yield { id: 'c6487', tid: 'i99', spoil: '0', lie: 'f' };
      yield { id: 'c9999', tid: 'i23', spoil: '0', lie: 'f' };
    },
  };
  const admission = await prepareShowcaseVndbTraits(tables, plan, port, subjects);
  const request = admission.request!({
    owner: { source: 'vndb_cross_media', external_id: 'c6487' },
    subject: '00000000-0000-4000-8000-000000000020',
  } as never);
  expect(request?.rows).toHaveLength(1);
  expect(request?.rows[0]).toMatchObject({ kind: 'character-trait', code: 'i23', spoiler: 0, lie: false });
  await expect(
    prepareShowcaseVndbTraits(
      tables,
      plan,
      { ...port, readReviewedSubject: async () => ({ subject: {} }) } as never,
      subjects,
    ),
  ).rejects.toThrow('not current');
});
