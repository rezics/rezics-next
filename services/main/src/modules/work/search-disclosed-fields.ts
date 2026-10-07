import type { AccessJudgments } from '../judgment/access.ts';
import type { MediaStore } from '../media/store.ts';
import type { SummaryReader } from '../media/summary.ts';
import { disclosePublicSearchFields, matchPublicDisclosedPhrase,
  InvalidPublicDisclosure, type PublicDisclosureInput }
  from '../search-disclosure/public-fields.ts';
import type { WorkActivationEnvironment } from './activate.ts';
import { InvalidPublicQuery, PublicQueryUnavailable } from './search-public.ts';

export interface PublicDisclosedFieldPhraseQuery extends PublicDisclosureInput {
  profile: 'public-disclosed-fields-phrase-v1';
  phrase: string;
}

/** Search only values admitted by their owners. No indexed hidden field enters
 * matching, score, count, facet or returned metadata. Cost is the owner's
 * bounded decision plus one in-memory scan of its one-MiB output. */
export async function queryPublicDisclosedFields(env: WorkActivationEnvironment,
  media: MediaStore | undefined, judgments: Pick<AccessJudgments, 'protectionChecks'> | undefined,
  input: PublicDisclosedFieldPhraseQuery,
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>, reader: SummaryReader = {}) {
  if (input.statements.length && !judgments) {
    throw new PublicQueryUnavailable('Statement disclosure owner is unavailable');
  }
  let decision;
  try {
    decision = await disclosePublicSearchFields(env, media, judgments, input, restrictedTitles, reader);
  } catch (error) {
    if (error instanceof InvalidPublicDisclosure) throw new InvalidPublicQuery(error.message);
    throw new PublicQueryUnavailable('public field disclosure is unavailable', { cause: error });
  }
  let matched;
  try { matched = matchPublicDisclosedPhrase(decision, input.phrase); }
  catch (error) {
    if (error instanceof InvalidPublicDisclosure) throw new InvalidPublicQuery(error.message);
    throw error;
  }
  return { contractVersion: '1' as const, profile: input.profile,
    resultGrain: 'field' as const, complete: true as const,
    countPrecision: 'exact' as const, facetPrecision: 'exact' as const,
    total: matched.total, results: matched.matches,
    facets: matched.facets,
    sourcePosition: { datasetId: 'product' as const, ...matched.sourcePosition } };
}
