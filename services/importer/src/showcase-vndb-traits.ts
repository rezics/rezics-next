import type { CrossMediaPlan, CrossMediaPort, CrossMediaTables } from './cross-media-seed.ts';
import { readVndbCharacterVocabularyBindings, vndbCharacterVocabularyAdmission } from './vndb-character-traits.ts';

/** Only reviewed dictionary codes on characters elected by the same seed plan. */
export async function prepareShowcaseVndbTraits(
  tables: CrossMediaTables,
  plan: CrossMediaPlan,
  port: CrossMediaPort,
  subjects: Readonly<Record<string, string>>,
) {
  const schemeId = subjects['vndb-character-traits-scheme'];
  if (!schemeId) throw new Error('Reviewed VNDB character-trait scheme is missing');
  const concepts = ['i23', 'i30'].map((code) => {
    const id = subjects[`vndb-character-traits-${code}`];
    if (!id) throw new Error(`Reviewed VNDB character trait ${code} is missing`);
    return { code, id };
  });
  const bindings = await readVndbCharacterVocabularyBindings(port, { traits: { schemeId, concepts } });
  if (bindings.concepts.length !== concepts.length) throw new Error('Reviewed VNDB character traits are not current');
  const characters = new Set(plan.entities.vndb.filter((row) => /^c[1-9][0-9]*$/.test(row.key)).map((row) => row.key));
  const codes = new Set(concepts.map((row) => row.code));
  const traits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for await (const row of tables.rows('vndb', 'chars_traits')) {
    if (!characters.has(String(row.id)) || !codes.has(String(row.tid))) continue;
    const key = `${row.id}:${row.tid}`;
    if (seen.has(key)) throw new Error('Duplicate selected VNDB character trait');
    seen.add(key);
    traits.push(row);
  }
  return vndbCharacterVocabularyAdmission(bindings, { ...plan, traits, appearances: [] });
}
