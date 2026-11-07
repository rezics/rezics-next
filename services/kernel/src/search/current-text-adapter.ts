import { analyzeInstalled } from './engine-analysis.ts';
import type { OpenSearch } from './opensearch.ts';
import { createCurrentTextMatcher } from './disclosure/current-text.ts';

/** Analysis is pinned to the installed physical generation. */
export function createCurrentTextDisclosure(search: OpenSearch, index: string) {
  return createCurrentTextMatcher((analyzer, text) => analyzeInstalled(search, index, { analyzer, text }));
}
export { CURRENT_TEXT_LIMITS } from './disclosure/current-text.ts';
