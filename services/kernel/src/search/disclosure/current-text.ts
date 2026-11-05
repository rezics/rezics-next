import { publicNames } from '../document-names.ts';
import { SearchUnavailableError, type OpenSearch } from '../opensearch.ts';
import type { IndexedSubject } from '../source.ts';
import type { TextNode } from '../text.ts';

type Analyzer = 'cjk_bigram_v2' | 'name_prefix';
type Token = Readonly<{ text: string; position: number }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTokens(value: unknown): Token[] {
  if (!record(value) || !Array.isArray(value.tokens))
    throw new SearchUnavailableError('OpenSearch current-text analysis is malformed');
  return value.tokens.map((entry: unknown) => {
    if (
      !record(entry) ||
      typeof entry.token !== 'string' ||
      !entry.token.isWellFormed() ||
      !Number.isSafeInteger(entry.position) ||
      (entry.position as number) < 0
    )
      throw new SearchUnavailableError('OpenSearch current-text analysis is malformed');
    return { text: entry.token, position: entry.position as number };
  });
}

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
          const response = await search.request<unknown>('POST', `/${index}/_analyze`, { analyzer, text });
          if (response.status !== 200)
            throw new SearchUnavailableError(`OpenSearch current-text analysis returned HTTP ${response.status}`);
          return readTokens(response.body);
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
              if (!leaves.has(key)) leaves.set(key, await analyze('cjk_bigram_v2', node.value));
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
      Promise.all(texts.map((text) => analyze('cjk_bigram_v2', text))),
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
    const query = await analyze('name_prefix', prefix);
    if (!query.length) return false;
    const names = [...new Set(publicNames(subject).map(({ value }) => value))];
    const candidates = await Promise.all(names.map((name) => analyze('name_prefix', name)));
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ text }) => text)));
    const final = query.at(-1)!.text;
    return (
      query.slice(0, -1).some(({ text }) => exact.has(text)) ||
      candidates.some((tokens) => tokens.some(({ text }) => text.startsWith(final)))
    );
  }

  return { matchesText, matchesPrefix };
}
