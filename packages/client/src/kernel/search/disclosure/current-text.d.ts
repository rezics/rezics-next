import type { IndexedSubject } from '../source.ts';
import type { TextNode } from '../text.ts';
import { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './admission.ts';
export type CurrentTextAnalyzer = typeof CJK_ANALYZER | typeof NAME_PREFIX_ANALYZER;
export type CurrentTextAnalysis = (analyzer: CurrentTextAnalyzer, text: string) => Promise<readonly EngineToken[]>;
export declare const CURRENT_TEXT_LIMITS: Readonly<{
    scanBytes: number;
    concurrency: 16;
}>;
/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export declare function createCurrentTextMatcher(analyzeCurrent: CurrentTextAnalysis): {
    matchesText: (subject: IndexedSubject, query: TextNode) => Promise<boolean>;
    matchesPrefix: (subject: IndexedSubject, prefix: string) => Promise<boolean>;
};
