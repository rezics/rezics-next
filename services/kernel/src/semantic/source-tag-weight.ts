import { createHash } from 'node:crypto';

export const vndbTagsRatingMetric = 'vndbTagsRating' as const;
export const vndbTagsRatingEndpoint = 'https://api.vndb.org/kana/vn' as const;
export const vndbTagsRatingDocumentation = 'https://api.vndb.org/kana#post-vn' as const;
const sourceId = /^v[1-9][0-9]{0,9}$/u;
const tagId = /^g[1-9][0-9]{0,9}$/u;
const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const snapshotLimit = 1024 * 1024;

type JsonNumber = Readonly<{ sourceNumber: string }>;
type JsonRecord = { [key: string]: JsonValue; sourceNumber?: never };
type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonRecord;

export type VndbSourceTagWeightInput = Readonly<{
  /** Exact Kana query endpoint that produced the response. */
  endpoint: typeof vndbTagsRatingEndpoint;
  /** Exact UTF-8 body sent to the Kana /vn endpoint for this response. */
  requestBody: Uint8Array | string;
  /** Exact UTF-8 response bytes from that Kana /vn query. */
  snapshot: Uint8Array | string;
  subjectId: string;
  contextId: string;
  property: 'schema:genre' | 'schema:keywords';
  conceptId: string;
  subjectRecordId: string;
  tagId: string;
}>;

export type VndbSourceTagWeightCandidate = Readonly<{
  contextId: string;
  statement: {
    property: { id: 'schema:genre' | 'schema:keywords' };
    value: { type: 'value'; content: string };
    rank: 'normal';
    qualifiers: {
      property: { id: string };
      value: { type: 'value'; content: string | { amount: string; unit: '1' } };
    }[];
    references: { parts: { property: { id: string }; value: { type: 'value'; content: string } }[] }[];
  };
  source: { recordId: string; tagId: string; digest: string; amount: string };
}>;

export type VndbSourceTagWeightResult =
  | { state: 'available'; candidate: VndbSourceTagWeightCandidate }
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'suppressed' }
  | { state: 'unsupported' }
  | { state: 'unavailable' };

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('sourceNumber' in value);
}

function isNumber(value: JsonValue | undefined): value is JsonNumber {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'sourceNumber' in value;
}

/** A small bounded JSON reader retains number tokens so a provider decimal is never rounded through Number. */
function parseSnapshot(source: string): JsonValue {
  let cursor = 0;
  const whitespace = () => {
    while (source[cursor] === ' ' || source[cursor] === '\n' || source[cursor] === '\r' || source[cursor] === '\t')
      cursor += 1;
  };
  const string = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 34) {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor)) as string;
      }
      if (code < 32) throw new TypeError('Invalid source JSON');
      if (code === 92) cursor += 1;
      cursor += 1;
    }
    throw new TypeError('Invalid source JSON');
  };
  const value = (depth: number): JsonValue => {
    if (depth > 32) throw new TypeError('Invalid source JSON');
    whitespace();
    const current = source[cursor];
    if (current === '"') return string();
    if (current === '{') {
      cursor += 1;
      whitespace();
      const result = Object.create(null) as JsonRecord;
      if (source[cursor] === '}') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        whitespace();
        if (source[cursor] !== '"') throw new TypeError('Invalid source JSON');
        const key = string();
        if (Object.hasOwn(result, key)) throw new TypeError('Invalid source JSON');
        whitespace();
        if (source[cursor++] !== ':') throw new TypeError('Invalid source JSON');
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') throw new TypeError('Invalid source JSON');
      }
      throw new TypeError('Invalid source JSON');
    }
    if (current === '[') {
      cursor += 1;
      whitespace();
      const result: JsonValue[] = [];
      if (source[cursor] === ']') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') throw new TypeError('Invalid source JSON');
      }
      throw new TypeError('Invalid source JSON');
    }
    if (source.startsWith('true', cursor)) {
      cursor += 4;
      return true;
    }
    if (source.startsWith('false', cursor)) {
      cursor += 5;
      return false;
    }
    if (source.startsWith('null', cursor)) {
      cursor += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(cursor));
    if (!match) throw new TypeError('Invalid source JSON');
    cursor += match[0].length;
    return { sourceNumber: match[0] };
  };
  const result = value(0);
  whitespace();
  if (cursor !== source.length) throw new TypeError('Invalid source JSON');
  return result;
}

function expandDecimal(token: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(token);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 256) return null;
  const digits = `${match[1]}${fraction}`;
  const scale = fraction.length - exponent;
  const expanded =
    scale <= 0
      ? `${digits}${'0'.repeat(-scale)}`
      : scale >= digits.length
        ? `0.${'0'.repeat(scale - digits.length)}${digits}`
        : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return expanded.length <= 126 ? expanded : null;
}

function positiveAtMostThree(amount: string): boolean {
  if (!/[1-9]/u.test(amount)) return false;
  const [wholeRaw = '0', fraction = ''] = amount.split('.');
  const whole = wholeRaw.replace(/^0+/u, '') || '0';
  if (whole.length > 1 || Number(whole) > 3) return false;
  return whole !== '3' || !/[1-9]/u.test(fraction);
}

function quantity(property: string, amount: string) {
  return { property: { id: property }, value: { type: 'value' as const, content: { amount, unit: '1' as const } } };
}
function literal(property: string, content: string) {
  return { property: { id: property }, value: { type: 'value' as const, content } };
}

/** Map one verified aggregate API record into an ordinary native candidate; this grants no write authority. */
export function produceVndbSourceTagWeightCandidate(input: VndbSourceTagWeightInput): VndbSourceTagWeightResult {
  if (input.property !== 'schema:genre' && input.property !== 'schema:keywords') return { state: 'unsupported' };
  if (input.endpoint !== vndbTagsRatingEndpoint) return { state: 'unavailable' };
  if (
    !subjectId.test(input.subjectId) ||
    !subjectId.test(input.contextId) ||
    !subjectId.test(input.conceptId) ||
    !sourceId.test(input.subjectRecordId)
  )
    return { state: 'unavailable' };
  if (!tagId.test(input.tagId)) return { state: 'unavailable' };
  const requestBytes = typeof input.requestBody === 'string' ? new TextEncoder().encode(input.requestBody) : input.requestBody;
  if (requestBytes.byteLength === 0 || requestBytes.byteLength > 2048) return { state: 'unavailable' };
  let request: JsonValue;
  try {
    request = parseSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(requestBytes));
  } catch {
    return { state: 'unavailable' };
  }
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(',') !== 'fields,filters,results' ||
    request.fields !== 'id,tags{id,rating,spoiler,lie}' ||
    !isNumber(request.results) ||
    request.results.sourceNumber !== '1' ||
    !Array.isArray(request.filters) ||
    request.filters.length !== 3 ||
    request.filters[0] !== 'id' ||
    request.filters[1] !== '=' ||
    request.filters[2] !== input.subjectRecordId
  )
    return { state: 'unavailable' };
  const bytes = typeof input.snapshot === 'string' ? new TextEncoder().encode(input.snapshot) : input.snapshot;
  if (bytes.byteLength === 0 || bytes.byteLength > snapshotLimit) return { state: 'unavailable' };
  let parsed: JsonValue;
  try {
    parsed = parseSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { state: 'unavailable' };
  }
  if (!isRecord(parsed) || parsed.more !== false || !Array.isArray(parsed.results) || parsed.results.length !== 1)
    return { state: 'unavailable' };
  const record = parsed.results[0];
  if (!isRecord(record) || record.id !== input.subjectRecordId || !Array.isArray(record.tags))
    return { state: 'unavailable' };
  const selected = record.tags.filter((entry) => isRecord(entry) && entry.id === input.tagId);
  if (selected.length === 0) return { state: 'absent' };
  if (selected.length !== 1) return { state: 'unavailable' };
  const tag = selected[0];
  if (!isRecord(tag)) return { state: 'unavailable' };
  if (tag.lie === true) return { state: 'suppressed' };
  if (tag.lie !== false) return { state: 'unavailable' };
  if (tag.rating === null) return { state: 'empty' };
  if (!isNumber(tag.rating) || !isNumber(tag.spoiler))
    return { state: 'unavailable' };
  const spoiler = Number(tag.spoiler.sourceNumber);
  if (!Number.isInteger(spoiler) || spoiler < 0 || spoiler > 2) return { state: 'unavailable' };
  const parsedRating = Number(tag.rating.sourceNumber);
  const decimal = expandDecimal(tag.rating.sourceNumber);
  if (!Number.isFinite(parsedRating) || parsedRating <= 0 || !decimal || !positiveAtMostThree(decimal))
    return { state: 'unavailable' };

  const digest = createHash('sha256').update(bytes).digest('hex');
  const citation = `https://vndb.org/${input.subjectRecordId}`;
  const statement: VndbSourceTagWeightCandidate['statement'] = {
    property: { id: input.property },
    value: { type: 'value', content: input.conceptId },
    rank: 'normal',
    qualifiers: [
      quantity('rezics:sourceTagWeight', `+${decimal}`),
      literal('rezics:sourceTagWeightMetric', vndbTagsRatingMetric),
      quantity('rezics:spoilerLevel', `+${spoiler}`),
    ],
    references: [
      {
        parts: [
          literal('schema:url', citation),
          literal('rezics:sourceTagId', input.tagId),
          literal('rezics:sourceSnapshot', `unversioned:sha256:${digest}`),
        ],
      },
      { parts: [literal('schema:url', vndbTagsRatingDocumentation)] },
    ],
  };
  return {
    state: 'available',
    candidate: {
      contextId: input.contextId,
      statement,
      source: { recordId: input.subjectRecordId, tagId: input.tagId, digest, amount: decimal },
    },
  };
}
