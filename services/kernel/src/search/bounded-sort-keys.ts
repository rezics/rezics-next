import { MAX_NAME_SORT_CHARACTERS, type IndexAction } from './document.ts';
import type { OpenSearch } from './opensearch.ts';

const MAX_ANALYZE_CONCURRENCY = 16;

type AnalyzeToken = {
  token: unknown;
  position: unknown;
  start_offset: unknown;
  end_offset: unknown;
};

type AnalyzeResponse = {
  tokens: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function normalizedKey(response: { status: number; body: AnalyzeResponse }, input: string): string {
  if (response.status !== 200) throw new Error(`OpenSearch analyze returned HTTP ${response.status}`);
  if (!isRecord(response.body) || !Array.isArray(response.body.tokens))
    throw new TypeError('OpenSearch analyze returned an invalid token list');

  const tokens = response.body.tokens as unknown[];
  if (tokens.length !== 1) throw new TypeError('OpenSearch name_key must return exactly one token per input');

  const token = tokens[0] as AnalyzeToken;
  if (
    !isRecord(token) ||
    typeof token.token !== 'string' ||
    !isScalarString(token.token) ||
    token.position !== 0 ||
    token.start_offset !== 0 ||
    token.end_offset !== input.length
  ) {
    throw new TypeError('OpenSearch name_key returned an invalid token position or value');
  }
  return token.token;
}

async function analyzeOne(search: OpenSearch, index: string, input: string): Promise<string> {
  const response = await search.request<AnalyzeResponse>('POST', `/${index}/_analyze`, {
    normalizer: 'name_key',
    text: input,
  });
  return normalizedKey(response, input);
}

/** Prepare full native name sort keys before bulk writes, replacing oversized keys with null. */
export async function prepareBoundedSortKeys(
  search: OpenSearch,
  index: string,
  actions: readonly IndexAction[],
): Promise<IndexAction[]> {
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
