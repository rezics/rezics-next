import { allCurrentMatch, anyCurrentMatch, notCurrentMatch } from '../current-filter-plan.ts';
import { publicNames } from '../document-names.ts';
import type { IndexedSubject, RelationFacetMatch } from '../source.ts';
import type { TextNode } from '../text.ts';
import { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './admission.ts';

export type CurrentTextAnalyzer = typeof CJK_ANALYZER | typeof NAME_PREFIX_ANALYZER;
export type CurrentTextAnalysis = (analyzer: CurrentTextAnalyzer, text: string) => Promise<readonly EngineToken[]>;
type Analyzer = CurrentTextAnalyzer;
export const CURRENT_TEXT_LIMITS = Object.freeze({ scanBytes: 32 * 1024, concurrency: 16 });

/** Only admitted whole values reach analysis; an omitted value leaves relevant coverage incomplete. */
function uniqueValues(subject: IndexedSubject, includeDescriptions: boolean): { values: string[]; complete: boolean } {
  const unique = new Set<string>();
  const values: string[] = [];
  let scanned = 0;
  const add = (language: string, value: string): boolean => {
    const size = Buffer.byteLength(language, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (scanned + size > CURRENT_TEXT_LIMITS.scanBytes) return false;
    scanned += size;
    if (!unique.has(value)) {
      unique.add(value);
      values.push(value);
    }
    return true;
  };
  for (const name of publicNames(subject)) {
    if (!add(name.language, name.value)) return { values, complete: false };
  }
  if (includeDescriptions) {
    for (const name of subject.descriptions) {
      if (!add(name.language, name.value)) return { values, complete: false };
    }
  }
  return { values, complete: true };
}

/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export function createCurrentTextMatcher(analyzeCurrent: CurrentTextAnalysis) {
  const cache = new Map<string, Promise<readonly EngineToken[]>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  async function analyze(analyzer: Analyzer, text: string): Promise<readonly EngineToken[]> {
    const key = `${analyzer}\0${text}`;
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        if (active >= CURRENT_TEXT_LIMITS.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
        else active++;
        try {
          return await analyzeCurrent(analyzer, text);
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      })();
      cache.set(key, result);
      void result.catch(() => cache.delete(key));
    }
    return result;
  }

  async function matchesText(subject: IndexedSubject, query: TextNode): Promise<RelationFacetMatch> {
    const { values: texts, complete } = uniqueValues(subject, true);
    const [queryLeaves, currentValues] = await Promise.all([
      (async () => {
        const leaves = new Map<string, readonly EngineToken[]>();
        const visit = async (node: TextNode): Promise<void> => {
          switch (node.kind) {
            case 'term':
            case 'phrase': {
              const key = `${node.kind}\0${node.value}`;
              if (!leaves.has(key)) leaves.set(key, await analyze(CJK_ANALYZER, node.value));
              return;
            }
            case 'not':
              return visit(node.child);
            case 'and':
            case 'or':
              await Promise.all(node.children.map(visit));
          }
        };
        await visit(query);
        return leaves;
      })(),
      Promise.all(texts.map((text) => analyze(CJK_ANALYZER, text))),
    ]);
    const all = new Set(currentValues.flatMap((tokens) => tokens.map(({ token }) => token)));
    const leafMatches = new Map<string, RelationFacetMatch>();
    const absence = complete ? false : 'not_proven';
    for (const [key, tokens] of queryLeaves) {
      if (!tokens.length) {
        leafMatches.set(key, false);
        continue;
      }
      if (key.startsWith('term\0')) {
        leafMatches.set(key, tokens.every(({ token }) => all.has(token)) ? true : absence);
        continue;
      }
      const phrase = tokens.map(({ token, position }) => ({ token, offset: position - tokens[0]!.position }));
      const matched = currentValues.some((candidate) => {
        for (const token of candidate) {
          if (token.token !== phrase[0]!.token) continue;
          if (
            phrase.every((part) =>
              candidate.some(
                (current) => current.position === token.position + part.offset && current.token === part.token,
              ),
            )
          )
            return true;
        }
        return false;
      });
      leafMatches.set(key, matched ? true : absence);
    }
    const evaluate = (node: TextNode): RelationFacetMatch => {
      switch (node.kind) {
        case 'term':
        case 'phrase':
          return leafMatches.get(`${node.kind}\0${node.value}`) ?? false;
        case 'not':
          return notCurrentMatch(evaluate(node.child));
        case 'and':
          return allCurrentMatch(node.children.map(evaluate));
        case 'or':
          return anyCurrentMatch(node.children.map(evaluate));
      }
    };
    return evaluate(query);
  }

  async function matchesPrefix(subject: IndexedSubject, prefix: string): Promise<RelationFacetMatch> {
    const query = await analyze(NAME_PREFIX_ANALYZER, prefix);
    if (!query.length) return false;
    const { values: names, complete } = uniqueValues(subject, false);
    const candidates = await Promise.all(names.map((name) => analyze(NAME_PREFIX_ANALYZER, name)));
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ token }) => token)));
    const final = query.at(-1)!.token;
    const matched =
      query.slice(0, -1).some(({ token }) => exact.has(token)) ||
      candidates.some((tokens) => tokens.some(({ token }) => token.startsWith(final)));
    return matched ? true : complete ? false : 'not_proven';
  }

  return { matchesText, matchesPrefix };
}
