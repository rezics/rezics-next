import { expect, test } from 'bun:test';
import { catalogueNameProjection, CATALOGUE_NAME_COST } from '../src/modules/search/names.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ type: 'literal', value });
function fixture(names: string[] = ['"Owned title"@en', '"別名"@zh-hant']) {
  const calls: string[] = [];
  const proposals: unknown[] = [];
  const env = {
    fuseki: {
      query: async (query: string, bytes: number) => {
        calls.push(query);
        expect(query).not.toContain('ORDER BY');
        expect(query).not.toContain('DISTINCT');
        expect(query).not.toContain('?namePredicate');
        expect(bytes).toBe(CATALOGUE_NAME_COST.responseBytes);
        const requests = [
          ...query.matchAll(/rv:rankedText\(rv:publicTitle, "", 64, "", ("(?:[^"\\]|\\.)*")\)/gu),
        ].map(
          (match) =>
            JSON.parse(JSON.parse(match[1]!)) as {
              catalogueNames: { work: string; override?: unknown };
            },
        );
        proposals.push(...requests.map((request) => request.catalogueNames));
        return {
          results: {
            bindings: requests.map((request) => ({
              work: binding(request.catalogueNames.work),
              recipe: binding(JSON.stringify({ names })),
            })),
          },
        };
      },
    },
  } as unknown as WorkActivationEnvironment;
  return { env, calls, proposals };
}
test('Catalogue body names use the shared bounded native recipe without population sorting', async () => {
  const f = fixture();
  const result = await catalogueNameProjection(f.env, [id(1), id(2)]);
  expect([...result.get(id(1))!]).toEqual(['"Owned title"@en', '"別名"@zh-hant']);
  expect(f.calls).toHaveLength(1);
  expect(f.proposals).toEqual([{ work: id(1) }, { work: id(2) }]);
  expect(await catalogueNameProjection(f.env, [])).toEqual(new Map());
  expect(f.calls).toHaveLength(1);
});
test('Catalogue proposals bind prospective owner headers and controlled title replacement', async () => {
  const f = fixture();
  const header = {
    kind: 'header' as const,
    originalTitle: null,
    localized: [{ language: 'fr', title: 'Titre', description: null, mainVersionLabel: null }],
  };
  await catalogueNameProjection(f.env, [id(1), id(2)], {
    work: id(1),
    header,
    title: { value: 'Old', language: 'en' },
    replacementTitle: { value: 'New', language: 'en' },
  });
  expect(f.proposals).toEqual([
    { work: id(1), override: { header, replacementTitle: { value: 'New', language: 'en' } } },
    { work: id(2) },
  ]);
  await catalogueNameProjection(f.env, [id(1)], { work: id(1), header: null });
  expect(f.proposals.at(-1)).toEqual({ work: id(1), override: { header: null } });
});
test('Catalogue recipes reject missing owners, duplicate rows, malformed values and over-budget caches', async () => {
  for (const names of [
    Array.from({ length: 65 }, (_, n) => `"name ${n}"@en`),
    ['not a literal'],
    ['"same"@en', '"same"@en'],
  ]) {
    await expect(catalogueNameProjection(fixture(names).env, [id(1)])).rejects.toThrow(
      'Catalogue name recipe',
    );
  }
  const f = fixture();
  f.env.fuseki.query = async () => ({ results: { bindings: [] } });
  await expect(catalogueNameProjection(f.env, [id(1)])).rejects.toThrow('incomplete');
  await expect(catalogueNameProjection(f.env, [id(1), id(1)])).rejects.toThrow('Work bound');
  await expect(
    catalogueNameProjection(
      f.env,
      Array.from({ length: 65 }, (_, n) => id(n)),
    ),
  ).rejects.toThrow('Work bound');
});
