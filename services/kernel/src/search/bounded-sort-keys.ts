import { MAX_NAME_SORT_CHARACTERS } from './document.ts';
import { analyzeInstalledMany, ENGINE_ANALYSIS_LIMITS, NAME_KEY_NORMALIZER } from './engine-analysis.ts';
import type { OpenSearch } from './opensearch.ts';

const MAX_ANALYSIS_BATCH_VALUES = Math.max(
  1,
  Math.floor(ENGINE_ANALYSIS_LIMITS.tokens / ENGINE_ANALYSIS_LIMITS.concurrency),
);
const MAX_ANALYSIS_BATCH_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const EMPTY_ANALYSIS_REQUEST_BYTES = encoder.encode(
  JSON.stringify({ normalizer: NAME_KEY_NORMALIZER, text: [] }),
).byteLength;

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

function analysisBatches(names: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let requestBytes = EMPTY_ANALYSIS_REQUEST_BYTES;

  for (const name of names) {
    const encodedNameBytes = encoder.encode(JSON.stringify(name)).byteLength;
    const nextBytes = requestBytes + encodedNameBytes + (current.length === 0 ? 0 : 1);
    if (
      current.length > 0 &&
      (current.length >= MAX_ANALYSIS_BATCH_VALUES || nextBytes > MAX_ANALYSIS_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      requestBytes = EMPTY_ANALYSIS_REQUEST_BYTES;
    }

    // A single name may exceed the batch byte limit. Keep it whole and alone, matching the old writer's
    // admission of that name while preventing it from making any neighboring request unbounded.
    requestBytes += encodedNameBytes + (current.length === 0 ? 0 : 1);
    current.push(name);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function normalizedKey(
  name: string,
  tokens: readonly { token: string; position: number; startOffset: number; endOffset: number }[],
): string {
  // The installed normalizer emits no token for an empty input. That is the exact empty key, not a missing result.
  if (name.length === 0 && tokens.length === 0) return '';
  if (tokens.length !== 1) throw new TypeError('OpenSearch name_key must return exactly one token per input');
  const token = tokens[0]!;
  if (
    !isScalarString(token.token) ||
    token.position !== 0 ||
    token.startOffset !== 0 ||
    token.endOffset !== name.length
  )
    throw new TypeError('OpenSearch name_key returned an invalid token position or value');
  return token.token;
}

/** Prepare full native name sort keys before bulk writes, replacing oversized keys with null. */
export async function prepareBoundedSortKeys<
  Action extends { op: 'index'; document: { name_sort?: string | null } } | { op: 'delete' },
>(search: OpenSearch, index: string, actions: readonly Action[]): Promise<Action[]> {
  // Set preserves first-seen order while keeping duplicate names out of native analysis.
  const distinctNames = new Set<string>();
  for (const action of actions) {
    if (action.op === 'index' && typeof action.document.name_sort === 'string')
      distinctNames.add(action.document.name_sort);
  }

  const names = [...distinctNames];
  // One normalized key yields one token. Dividing the token ceiling by maximum concurrency caps in-flight values too.
  const batches = analysisBatches(names);
  const normalized = new Map<string, string>();
  let next = 0;
  let failed = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!failed) {
      const position = next;
      next += 1;
      const batch = batches[position];
      if (batch === undefined) return;
      try {
        const groups = await analyzeInstalledMany(search, index, { normalizer: NAME_KEY_NORMALIZER, text: batch });
        for (let item = 0; item < batch.length; item += 1)
          normalized.set(batch[item]!, normalizedKey(batch[item]!, groups[item]!));
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }

  const concurrency = Math.min(ENGINE_ANALYSIS_LIMITS.concurrency, batches.length);
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
