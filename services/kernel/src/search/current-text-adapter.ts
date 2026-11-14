import { analyzeInstalledMany } from './engine-analysis.ts';
import type { OpenSearch } from './opensearch.ts';
import { createCurrentTextMatcher } from './disclosure/current-text.ts';

/** Analysis is pinned to the installed physical generation. */
export function createCurrentTextDisclosure(search: OpenSearch, index: string) {
  return createCurrentTextMatcher((analyzer, texts) => analyzeInstalledMany(search, index, { analyzer, text: texts }));
}
export { CURRENT_TEXT_LIMITS } from './disclosure/current-text.ts';
