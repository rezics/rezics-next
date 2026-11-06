import { MAX_NAME_SORT_CHARACTERS } from './document.ts';
import { analyzeInstalled, NAME_KEY_NORMALIZER } from './engine-analysis.ts';
import type { OpenSearch } from './opensearch.ts';

const MAX_ANALYZE_CONCURRENCY = 16;

function isScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

async function analyzeOne(search: OpenSearch, index: string, input: string): Promise<string> {
  const tokens = await analyzeInstalled(search, index, { normalizer: NAME_KEY_NORMALIZER, text: input });
  if (tokens.length !== 1) throw new TypeError('OpenSearch name_key must return exactly one token per input');
  const token = tokens[0]!;
  if (
    !isScalarString(token.token) ||
    token.position !== 0 ||
    token.startOffset !== 0 ||
    token.endOffset !== input.length
  )
    throw new TypeError('OpenSearch name_key returned an invalid token position or value');
  return token.token;
}

/** Prepare full native name sort keys before bulk writes, replacing oversized keys with null. */
export async function prepareBoundedSortKeys<
  Action extends { op: 'index'; document: { name_sort?: string | null } } | { op: 'delete' },
>(search: OpenSearch, index: string, actions: readonly Action[]): Promise<Action[]> {
  // Analyze flattens multi-text token lists without input IDs. Singleton calls keep empty outputs aligned.
  const distinctNames = new Set<string>();
  for (const action of actions) {
    if (action.op === 'index' && typeof action.document.name_sort === 'string')
      distinctNames.add(action.document.name_sort);
  }

  const names = [...distinctNames];
  const normalized = new Map<string, string>();
  let next = 0;
  let failed = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!failed) {
      const position = next;
      next += 1;
      const name = names[position];
      if (name === undefined) return;
      try {
        normalized.set(name, await analyzeOne(search, index, name));
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }

  const concurrency = Math.min(MAX_ANALYZE_CONCURRENCY, names.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failed) throw failure;

  return actions.map((action) => {
    if (action.op !== 'index' || typeof action.document.name_sort !== 'string') return action;
    const value = normalized.get(action.document.name_sort);
    if (value === undefined) throw new Error('OpenSearch name_key result is missing');
    const name_sort = value.length <= MAX_NAME_SORT_CHARACTERS ? value : null;
    if (name_sort === action.document.name_sort) return action;
    return { ...action, document: { ...action.document, name_sort } };
  });
}
