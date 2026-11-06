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
type Token = Readonly<{ text: string; position: number }>;

/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export function createCurrentTextDisclosure(search: OpenSearch, index: string) {
  const cache = new Map<string, Promise<Token[]>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  async function analyze(analyzer: Analyzer, text: string): Promise<Token[]> {
    const key = `${analyzer}\0${text}`;
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        if (active >= 16) await new Promise<void>((resolve) => waiting.push(resolve));
        else active++;
        try {
          const tokens: readonly EngineToken[] = await analyzeInstalled(search, index, { analyzer, text });
          return tokens.map(({ token, position }) => ({ text: token, position }));
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

  const values = (subject: IndexedSubject) => [
    ...new Set([...publicNames(subject).map(({ value }) => value), ...subject.descriptions.map(({ value }) => value)]),
  ];

  async function matchesText(subject: IndexedSubject, query: TextNode): Promise<boolean> {
    const texts = values(subject);
    const [queryLeaves, currentValues] = await Promise.all([
      (async () => {
        const leaves = new Map<string, Token[]>();
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
    const all = new Set(currentValues.flatMap((tokens) => tokens.map(({ text }) => text)));
    const leafMatches = new Map<string, boolean>();
    for (const [key, tokens] of queryLeaves) {
      if (!tokens.length) {
        leafMatches.set(key, false);
        continue;
      }
      if (key.startsWith('term\0')) {
        leafMatches.set(
          key,
          tokens.every(({ text }) => all.has(text)),
        );
        continue;
      }
      const phrase = tokens.map(({ text, position }) => ({ text, offset: position - tokens[0]!.position }));
      const matched = currentValues.some((candidate) => {
        for (const token of candidate) {
          if (token.text !== phrase[0]!.text) continue;
          if (
            phrase.every((part) =>
              candidate.some(
                (current) => current.position === token.position + part.offset && current.text === part.text,
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
    const names = [...new Set(publicNames(subject).map(({ value }) => value))];
    const candidates = await Promise.all(names.map((name) => analyze(NAME_PREFIX_ANALYZER, name)));
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ text }) => text)));
    const final = query.at(-1)!.text;
    return (
      query.slice(0, -1).some(({ text }) => exact.has(text)) ||
      candidates.some((tokens) => tokens.some(({ text }) => text.startsWith(final)))
    );
  }

  return { matchesText, matchesPrefix };
}
