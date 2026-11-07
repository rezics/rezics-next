import { analyzeInstalled, CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from '../engine-analysis.ts';
import type { OpenSearch } from '../opensearch.ts';
import { createCurrentTextMatcher } from '../disclosure-application.ts';

export type CurrentTextAnalyzer = typeof CJK_ANALYZER | typeof NAME_PREFIX_ANALYZER;
export type CurrentTextAnalysis = (analyzer: CurrentTextAnalyzer, text: string) => Promise<readonly EngineToken[]>;

/** Native adapter: analysis always uses the installed physical Search generation. */
export function createCurrentTextDisclosure(search: OpenSearch, index: string) {
  return createCurrentTextMatcher((analyzer, text) => analyzeInstalled(search, index, { analyzer, text }));
}

export { CURRENT_TEXT_LIMITS } from '../disclosure-application.ts';
