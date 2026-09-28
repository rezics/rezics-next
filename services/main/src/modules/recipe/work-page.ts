import { GRAPHS, RV, iri } from '../work/activate.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadUnavailable } from '../work/read-session.ts';
import { compositionForMainVersion, readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage, readStructureMeasures } from '../structure/read.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import { scaleIngredients } from './operations.ts';
import { exactRational } from './quantity.ts';

/** One selected Recipe revision. At most 4,096 occurrences and 64 measures. */
export async function readRecipeWorkPage(session: WorkReadSession, work: string, servings?: number) {
  if (servings !== undefined && (!Number.isInteger(servings) || servings < 1 || servings > 100)) {
    throw new WorkReadInvalid('Servings must be a whole number from 1 to 100');
  }
  const basis = await readWorkBasis(session, work);
  // Work basis already fences visibility. A non-Recipe cannot acquire a Recipe view.
  const type = await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/Recipe> . } }`);
  if (!type.boolean) return null;
  const structure = await compositionForMainVersion(session.deps.environment, basis.card.mainVersion);
  if (!structure) return null;
  const header = await readCompositionHeader(session.deps.environment, structure);
  if (!header || header.profile !== 'recipe-composition' || header.owner !== work
    || header.component !== basis.card.mainVersion) {
    throw new WorkReadUnavailable('Recipe Structure differs from selected Work');
  }
  const records: OccurrenceRecord[] = [];
  let pages = 0;
  let pagesRead = 0;
  const parents = [structure];
  for (let index = 0; index < parents.length; index++) {
    let after: string | undefined;
    do {
      const page = await readCompositionPage(session.deps.environment, { structure, revision: header.head,
        parent: parents[index], ...(after ? { after } : {}), limit: 100,
        canReadTarget: async () => false });
      pages++;
      pagesRead += page.cost.pagesRead;
      records.push(...page.occurrences);
      after = page.next ?? undefined;
      for (const item of page.occurrences) {
        if (item.state === 'active' && item.role === 'group') parents.push(item.occurrence);
      }
      if (records.length > 4096 || parents.length > 4096) {
        throw new WorkReadUnavailable('Recipe exceeds page limit');
      }
    } while (after);
  }
  const measures = await readStructureMeasures(session.deps.environment, { structure, revision: header.head });
  const base = measures.measures.find(item => item.kind === 'servings');
  if (servings !== undefined && (!base || base.value.numerator === 0)) {
    throw new WorkReadInvalid('Recipe has no scalable servings measure');
  }
  const factor = base && servings !== undefined && base.value.numerator > 0
    ? exactRational(BigInt(servings) * BigInt(base.value.denominator), BigInt(base.value.numerator))
    : exactRational(1n, 1n);
  const ingredients = scaleIngredients(records, factor).map(item => ({ ...item,
    ...(item.amount ? { amount: { numerator: Number(item.amount.numerator),
      denominator: Number(item.amount.denominator) } } : {}),
    ...(item.amountUpper ? { amountUpper: { numerator: Number(item.amountUpper.numerator),
      denominator: Number(item.amountUpper.denominator) } } : {}) }));
  const result = { profile: 'recipe-work-page-v1' as const, structure, revision: header.head,
    occurrences: records.filter(item => item.state === 'active'), measures: measures.measures,
    ingredients,
    cost: { pages, pagesRead, occurrences: records.length } };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new WorkReadLimit('Recipe page exceeds 1 MiB');
  }
  await fenceWorkBasis(session, basis);
  return result;
}
