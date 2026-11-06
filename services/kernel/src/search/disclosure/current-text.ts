import { publicNames } from '../document-names.ts';
import {
  analyzeInstalled,
  CJK_ANALYZER,
  NAME_PREFIX_ANALYZER,
  type EngineToken,
} from '../engine-analysis.ts';
import type { OpenSearch } from '../opensearch.ts';
import type { IndexedSubject } from '../source.ts';
import type { TextNode } from '../text.ts';

type Analyzer = typeof CJK_ANALYZER | typeof NAME_PREFIX_ANALYZER;

/** Analyzer concurrency matches ENGINE_ANALYSIS_LIMITS as a module-init literal; that owner file is not a literal leaf. */
export const CURRENT_TEXT_LIMITS = Object.freeze({
  scanBytes: 32 * 1024,
  concurrency: 16,
});

function uniqueValues(subject: IndexedSubject, includeDescriptions: boolean): string[] {
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
    if (!add(name.language, name.value)) return values;
  }
  if (includeDescriptions) {
    for (const name of subject.descriptions) {
      if (!add(name.language, name.value)) return values;
    }
  }
  return values;
}

/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export function createCurrentTextDisclosure(search: OpenSearch, index: string) {
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
          return await analyzeInstalled(search, index, { analyzer, text });
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

  async function matchesText(subject: IndexedSubject, query: TextNode): Promise<boolean> {
    const texts = uniqueValues(subject, true);
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
    const leafMatches = new Map<string, boolean>();
    for (const [key, tokens] of queryLeaves) {
      if (!tokens.length) {
        leafMatches.set(key, false);
        continue;
      }
      if (key.startsWith('term\0')) {
        leafMatches.set(
          key,
          tokens.every(({ token }) => all.has(token)),
        );
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
      leafMatches.set(key, matched);
    }
    const evaluate = (node: TextNode): boolean => {
      switch (node.kind) {
        case 'term':
        case 'phrase':
          return leafMatches.get(`${node.kind}\0${node.value}`) ?? false;
        case 'not':
          return !evaluate(node.child);
        case 'and':
          return node.children.every(evaluate);
        case 'or':
          return node.children.some(evaluate);
      }
    };
    return evaluate(query);
  }

  async function matchesPrefix(subject: IndexedSubject, prefix: string): Promise<boolean> {
    const query = await analyze(NAME_PREFIX_ANALYZER, prefix);
    if (!query.length) return false;
    const names = uniqueValues(subject, false);
    const candidates = await Promise.all(names.map((name) => analyze(NAME_PREFIX_ANALYZER, name)));
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ token }) => token)));
    const final = query.at(-1)!.token;
    return (
      query.slice(0, -1).some(({ token }) => exact.has(token)) ||
      candidates.some((tokens) => tokens.some(({ token }) => token.startsWith(final)))
    );
  }

  return { matchesText, matchesPrefix };
}
