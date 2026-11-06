import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';

/** Released development analysis plugin. The unmodified upstream image does not install it. */
export const ANALYSIS_ICU_PLUGIN = 'analysis-icu';
export const CJK_ANALYZER = 'cjk_bigram_v2';
export const NAME_PREFIX_ANALYZER = 'name_prefix';
export const NAME_KEY_NORMALIZER = 'name_key';

export type EngineToken = Readonly<{
  token: string;
  position: number;
  startOffset: number;
  endOffset: number;
}>;

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
    (value.end_offset as number) < (value.start_offset as number)
  )
    throw new SearchUnavailableError('OpenSearch analysis is malformed');
  return {
    token: value.token,
    position: value.position as number,
    startOffset: value.start_offset as number,
    endOffset: value.end_offset as number,
  };
}

/**
 * Analyze against an installed generation, or the node-level `_analyze` API when `index` is omitted.
 * Tokens keep native offsets so callers can bind folded matches back to exact source text.
 */
export async function analyzeInstalled(
  search: OpenSearch,
  index: string | undefined,
  request: EngineAnalyzeRequest,
): Promise<readonly EngineToken[]> {
  if (!request.text.isWellFormed()) throw new TypeError('Analysis text must be well-formed UTF-16');
  const path = index ? `/${index}/_analyze` : '/_analyze';
  const response = await search.request<unknown>('POST', path, {
    text: request.text,
    ...(request.analyzer === undefined ? {} : { analyzer: request.analyzer }),
    ...(request.normalizer === undefined ? {} : { normalizer: request.normalizer }),
    ...(request.tokenizer === undefined ? {} : { tokenizer: request.tokenizer }),
    ...(request.char_filter === undefined ? {} : { char_filter: [...request.char_filter] }),
    ...(request.filter === undefined ? {} : { filter: [...request.filter] }),
  });
  if (response.status !== 200)
    throw new SearchUnavailableError(`OpenSearch analysis returned HTTP ${response.status}`);
  if (!record(response.body) || !Array.isArray(response.body.tokens) || response.body.tokens.length > 4096)
    throw new SearchUnavailableError('OpenSearch analysis is malformed');
  return response.body.tokens.map(readToken);
}

export async function installedAnalysisPlugins(search: OpenSearch): Promise<readonly string[]> {
  const response = await search.request<unknown>('GET', '/_cat/plugins', undefined, { query: { format: 'json' } });
  if (response.status !== 200 || !Array.isArray(response.body) || response.body.length > 256)
    throw new SearchUnavailableError('OpenSearch plugin inventory is malformed');
  return response.body.map((entry) => {
    if (!record(entry) || typeof entry.component !== 'string' || !entry.component.isWellFormed())
      throw new SearchUnavailableError('OpenSearch plugin inventory is malformed');
    return entry.component;
  });
}

/** The documented development node is OpenSearch 3.x with analysis-icu. */
export async function requireDevelopmentAnalyzer(search: OpenSearch): Promise<{ version: string }> {
  const root = await search.request<unknown>('GET', '/');
  const version = record(root.body) && record(root.body.version) ? root.body.version.number : undefined;
  if (root.status !== 200 || typeof version !== 'string' || !/^3\.\d+\.\d+/.test(version))
    throw new SearchUnavailableError('OpenSearch development node is not 3.x');
  const plugins = await installedAnalysisPlugins(search);
  if (!plugins.includes(ANALYSIS_ICU_PLUGIN))
    throw new SearchUnavailableError('OpenSearch development node is missing analysis-icu');
  const folded = await analyzeInstalled(search, undefined, {
    tokenizer: 'icu_tokenizer',
    filter: ['icu_folding'],
    text: 'Ｒｕｓｔ',
  });
  if (folded.map(({ token }) => token).join() !== 'rust')
    throw new SearchUnavailableError('OpenSearch ICU folding is not the released analyzer');
  return { version };
}
