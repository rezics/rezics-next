import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import {
  readVndbCharacterVocabularyBindings,
  vndbCharacterVocabularyAdmission,
  type VndbCharacterTraitPlan,
} from './vndb-character-traits.ts';

const reviewedCodes = ['i23', 'i30'] as const;
const characterId = /^c[1-9][0-9]*$/u;

/** Keep only current reviewed trait Concepts and exact associations on elected VNDB characters. */
export async function prepareShowcaseVndbTraits(
  plan: CrossMediaPlan,
  sourcePlan: VndbCharacterTraitPlan,
  port: CrossMediaPort,
  subjects: Readonly<Record<string, string>>,
) {
  const schemeId = subjects['vndb-character-traits-scheme'];
  if (!schemeId) throw new Error('Reviewed VNDB character-trait scheme is missing');
  const concepts = reviewedCodes.map((code) => {
    const id = subjects[`vndb-character-traits-${code}`];
    if (!id) throw new Error(`Reviewed VNDB character trait ${code} is missing`);
    return { code, id };
  });
  const bindings = await readVndbCharacterVocabularyBindings(port, { traits: { schemeId, concepts } });
  if (bindings.concepts.length !== concepts.length) throw new Error('Reviewed VNDB character traits are not current');

  const characters = new Set(plan.entities.vndb.filter((row) => characterId.test(row.key)).map((row) => row.key));
  const codes = new Set<string>(reviewedCodes);
  const traits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const row of sourcePlan.traits) {
    if (!characters.has(String(row.id)) || !codes.has(String(row.tid))) continue;
    if ((row.lie !== 'f' && row.lie !== false) || !/^(?:0|1|2)$/u.test(String(row.spoil))) continue;
    const key = `${row.id}:${row.tid}`;
    if (seen.has(key)) throw new Error('Duplicate selected VNDB character trait');
    seen.add(key);
    traits.push(row);
  }
  const vocabularyPlan = { ...sourcePlan, traits, appearances: [] };
  return {
    bindings,
    traits,
    vocabularyAdmission: vndbCharacterVocabularyAdmission(bindings, vocabularyPlan),
  };
}
