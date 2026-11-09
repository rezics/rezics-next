import { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './disclosure/admission.ts';
export { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './disclosure/admission.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';

/** Released development analysis plugin. The unmodified upstream image does not install it. */
export const ANALYSIS_ICU_PLUGIN = 'analysis-icu';
export const NAME_KEY_NORMALIZER = 'name_key';

export const ENGINE_ANALYSIS_LIMITS = Object.freeze({
  tokens: 4096,
  concurrency: 16,
  plugins: 256,
});

export type EngineAnalyzeRequest = Readonly<{
  text: string;
  analyzer?: string;
  normalizer?: string;
  tokenizer?: string;
  char_filter?: readonly string[];
  filter?: readonly string[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(message = 'OpenSearch analysis is malformed'): never {
  throw new SearchUnavailableError(message);
}

function readToken(value: unknown): EngineToken {
  if (
    !record(value) ||
    typeof value.token !== 'string' ||
    !value.token.isWellFormed() ||
    !Number.isSafeInteger(value.position) ||
    (value.position as number) < 0 ||
    !Number.isSafeInteger(value.start_offset) ||
    (value.start_offset as number) < 0 ||
    !Number.isSafeInteger(value.end_offset) ||
    (value.end_offset as number) <= (value.start_offset as number)
  )
    unavailable();
  return {
    token: value.token,
    position: value.position as number,
    startOffset: value.start_offset as number,
    endOffset: value.end_offset as number,
  };
}

/** Exact original-language slice for a native token. Folded token text is never substituted. */
export function sourceSpan(text: string, token: EngineToken): string {
  if (token.startOffset > text.length || token.endOffset > text.length) unavailable();
  const span = text.slice(token.startOffset, token.endOffset);
  if (!span.isWellFormed() || span.length === 0) unavailable();
  return span;
}

/**
 * Analyze against an installed generation, or the node-level `_analyze` API when `index` is omitted.
 * Tokens keep native offsets so callers can bind folded matches back to exact source text.
 * Malformed third-party replies are SearchUnavailableError and do not retain engine bodies.
 */
export async function analyzeInstalled(
  search: OpenSearch,
  index: string | undefined,
  request: EngineAnalyzeRequest,
): Promise<readonly EngineToken[]> {
  if (!request.text.isWellFormed()) throw new TypeError('Analysis text must be well-formed UTF-16');
  const path = index ? `/${index}/_analyze` : '/_analyze';
  let response: { status: number; body: unknown };
  try {
    response = await search.request<unknown>('POST', path, {
      text: request.text,
      ...(request.analyzer === undefined ? {} : { analyzer: request.analyzer }),
      ...(request.normalizer === undefined ? {} : { normalizer: request.normalizer }),
      ...(request.tokenizer === undefined ? {} : { tokenizer: request.tokenizer }),
      ...(request.char_filter === undefined ? {} : { char_filter: [...request.char_filter] }),
      ...(request.filter === undefined ? {} : { filter: [...request.filter] }),
    });
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw error;
    if (error instanceof OpenSearchError) unavailable(`OpenSearch analysis returned HTTP ${error.status}`);
    throw error;
  }
  if (response.status !== 200) unavailable(`OpenSearch analysis returned HTTP ${response.status}`);
  if (
    !record(response.body) ||
    !Array.isArray(response.body.tokens) ||
    response.body.tokens.length > ENGINE_ANALYSIS_LIMITS.tokens
  )
    unavailable();
  const tokens = response.body.tokens.map(readToken);
  // These installed text analyzers omit empty terms. Accepting one makes every name match an empty prefix.
  // Keep normalizers separate: removing an ignorable character can legitimately produce an empty key.
  if (
    (request.analyzer === CJK_ANALYZER || request.analyzer === NAME_PREFIX_ANALYZER) &&
    tokens.some(({ token }) => token.length === 0)
  )
    unavailable();
  for (const token of tokens) sourceSpan(request.text, token);
  return tokens;
}

export async function installedAnalysisPlugins(search: OpenSearch): Promise<readonly string[]> {
  let response: { status: number; body: unknown };
  try {
    response = await search.request<unknown>('GET', '/_cat/plugins', undefined, { query: { format: 'json' } });
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw error;
    if (error instanceof OpenSearchError) unavailable('OpenSearch plugin inventory is malformed');
    throw error;
  }
  if (response.status !== 200 || !Array.isArray(response.body) || response.body.length > ENGINE_ANALYSIS_LIMITS.plugins)
    unavailable('OpenSearch plugin inventory is malformed');
  return response.body.map((entry) => {
    if (!record(entry) || typeof entry.component !== 'string' || !entry.component.isWellFormed())
      unavailable('OpenSearch plugin inventory is malformed');
    return entry.component;
  });
}

/** The documented development node is OpenSearch 3.x with analysis-icu. */
export async function requireDevelopmentAnalyzer(search: OpenSearch): Promise<{ version: string }> {
  let root: { status: number; body: unknown };
  try {
    root = await search.request<unknown>('GET', '/');
  } catch (error) {
    if (error instanceof SearchUnavailableError) throw error;
    if (error instanceof OpenSearchError) unavailable('OpenSearch development node is not 3.x');
    throw error;
  }
  const version = record(root.body) && record(root.body.version) ? root.body.version.number : undefined;
  if (root.status !== 200 || typeof version !== 'string' || !/^3\.\d+\.\d+/.test(version))
    unavailable('OpenSearch development node is not 3.x');
  const plugins = await installedAnalysisPlugins(search);
  if (!plugins.includes(ANALYSIS_ICU_PLUGIN)) unavailable('OpenSearch development node is missing analysis-icu');
  const folded = await analyzeInstalled(search, undefined, {
    tokenizer: 'icu_tokenizer',
    filter: ['icu_folding'],
    text: 'Ｒｕｓｔ',
  });
  if (folded.map(({ token }) => token).join() !== 'rust')
    unavailable('OpenSearch ICU folding is not the released analyzer');
  return { version };
}
