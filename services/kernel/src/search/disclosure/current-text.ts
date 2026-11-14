import { allCurrentMatch, anyCurrentMatch, notCurrentMatch } from '../current-filter-plan.ts';
import { publicNames } from '../document-names.ts';
import type { IndexedSubject, RelationFacetMatch } from '../source.ts';
import type { TextNode } from '../text.ts';
import { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './admission.ts';

export type CurrentTextAnalyzer = typeof CJK_ANALYZER | typeof NAME_PREFIX_ANALYZER;
export type CurrentTextAnalysis = (
  analyzer: CurrentTextAnalyzer,
  texts: readonly string[],
) => Promise<readonly (readonly EngineToken[])[]>;
type Analyzer = CurrentTextAnalyzer;
export const CURRENT_TEXT_LIMITS = Object.freeze({
  scanBytes: 32 * 1024,
  batchBytes: 4 * 1024,
  batchesPerSubject: 9,
  concurrency: 16,
});

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

function analysisBatches(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    bytes = 0;
  };
  for (const text of texts) {
    const size = Buffer.byteLength(text, 'utf8');
    if (batch.length && (size > CURRENT_TEXT_LIMITS.batchBytes || bytes + size > CURRENT_TEXT_LIMITS.batchBytes))
      flush();
    if (size > CURRENT_TEXT_LIMITS.batchBytes) batches.push([text]);
    else {
      batch.push(text);
      bytes += size;
    }
  }
  flush();
  return batches;
}

/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export function createCurrentTextMatcher(analyzeCurrent: CurrentTextAnalysis) {
  const cache = new Map<string, Promise<readonly EngineToken[]>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  async function schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= CURRENT_TEXT_LIMITS.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await Promise.resolve().then(operation);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function analyze(analyzer: Analyzer, texts: readonly string[]): Promise<readonly (readonly EngineToken[])[]> {
    const unique = [...new Set(texts)];
    const missing = unique.filter((text) => !cache.has(JSON.stringify([analyzer, text])));
    for (const batch of analysisBatches(missing)) {
      const pending = schedule(() => analyzeCurrent(analyzer, batch));
      for (let i = 0; i < batch.length; i++) {
        const text = batch[i]!;
        const key = JSON.stringify([analyzer, text]);
        const result = pending.then((values) => values[i]!);
        cache.set(key, result);
        void result.catch(() => {
          if (cache.get(key) === result) cache.delete(key);
        });
      }
    }
    return Promise.all(texts.map((text) => cache.get(JSON.stringify([analyzer, text]))!));
  }

  function queryLeaves(query: TextNode): Map<string, { kind: 'term' | 'phrase'; value: string }> {
    const leaves = new Map<string, { kind: 'term' | 'phrase'; value: string }>();
    const visit = (node: TextNode): void => {
      switch (node.kind) {
        case 'term':
        case 'phrase':
          leaves.set(JSON.stringify([node.kind, node.value]), { kind: node.kind, value: node.value });
          return;
        case 'not':
          visit(node.child);
          return;
        case 'and':
        case 'or':
          for (const child of node.children) visit(child);
      }
    };
    visit(query);
    return leaves;
  }

  async function matchesText(subject: IndexedSubject, query: TextNode): Promise<RelationFacetMatch> {
    const { values: texts, complete } = uniqueValues(subject, true);
    const leaves = queryLeaves(query);
    const inputs = [...new Set([...leaves.values()].map(({ value }) => value).concat(texts))];
    const analyzed = await analyze(CJK_ANALYZER, inputs);
    const byText = new Map(inputs.map((text, index) => [text, analyzed[index]!]));
    const currentValues = texts.map((text) => byText.get(text)!);
    const all = new Set(currentValues.flatMap((tokens) => tokens.map(({ token }) => token)));
    const leafMatches = new Map<string, RelationFacetMatch>();
    const absence = complete ? false : 'not_proven';
    for (const [key, leaf] of leaves) {
      const tokens = byText.get(leaf.value)!;
      if (!tokens.length) {
        leafMatches.set(key, false);
        continue;
      }
      if (leaf.kind === 'term') {
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
          return leafMatches.get(JSON.stringify([node.kind, node.value])) ?? false;
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
    const { values: names, complete } = uniqueValues(subject, false);
    const inputs = [...new Set([prefix, ...names])];
    const analyzed = await analyze(NAME_PREFIX_ANALYZER, inputs);
    const byText = new Map(inputs.map((text, index) => [text, analyzed[index]!]));
    const query = byText.get(prefix)!;
    if (!query.length) return false;
    const candidates = names.map((name) => byText.get(name)!);
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ token }) => token)));
    const final = query.at(-1)!.token;
    const matched =
      query.slice(0, -1).some(({ token }) => exact.has(token)) ||
      candidates.some((tokens) => tokens.some(({ token }) => token.startsWith(final)));
    return matched ? true : complete ? false : 'not_proven';
  }

  return { matchesText, matchesPrefix };
}
