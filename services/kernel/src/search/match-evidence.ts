import { createHash } from 'node:crypto';
import type { IndexedSubject } from './source.ts';
import type { TextLeaf } from './text.ts';

export type MatchEvidenceField = 'title' | 'alias' | 'description';
export type MatchEvidenceReason = {
  field: MatchEvidenceField;
  language: string;
  text: string;
  spans: { start: number; end: number }[];
};
export type MatchEvidence =
  | { state: 'absent' }
  | { state: 'unsupported' }
  | { state: 'unavailable' }
  | {
      state: 'current';
      source: { id: string; revision: number };
      query: string;
      reasons: MatchEvidenceReason[];
    };

export const MATCH_EVIDENCE_LIMITS = Object.freeze({
  reasons: 3,
  spans: 8,
  textBytes: 256,
  fragmentBytes: 1024,
  sourceValues: 32,
  sourceBytes: 32_768,
  enginePageBytes: 262_144,
  pageBytes: 131_072,
});

export type MatchEvidenceQuery = Readonly<{
  query: Record<string, unknown>;
  highlight: Record<string, unknown>;
  queryBinding: string;
  names: Readonly<Record<'names' | 'descriptions', readonly string[]>>;
}>;

type CompiledText = { query: Record<string, unknown>; leaves: readonly TextLeaf[] };
type TextField = 'names' | 'descriptions';
const textFields: readonly TextField[] = ['names', 'descriptions'];
const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function leafQuery(field: TextField, leaf: TextLeaf, name: string): Record<string, unknown> {
  return leaf.kind === 'term'
    ? { match: { [field]: { query: leaf.value, operator: 'and', boost: 0, _name: name } } }
    : { match_phrase: { [field]: { query: leaf.value, boost: 0, _name: name } } };
}

/** Add zero-score named field probes while retaining the installed text query as the sole required clause. */
export function compileMatchEvidence(compiled: CompiledText): MatchEvidenceQuery {
  const names: Record<TextField, string[]> = { names: [], descriptions: [] };
  const probes: Record<TextField, Record<string, unknown>[]> = { names: [], descriptions: [] };
  for (const leaf of compiled.leaves) {
    if (leaf.negated) continue;
    for (const field of textFields) {
      const name = `e_${field === 'names' ? 'n' : 'd'}_${leaf.name}`;
      names[field].push(name);
      probes[field].push(leafQuery(field, leaf, name));
    }
  }
  const should = textFields.flatMap((field) => probes[field]);
  return {
    query: {
      bool: {
        must: [compiled.query],
        should,
        minimum_should_match: 0,
      },
    },
    highlight: {
      pre_tags: ['<em>'],
      post_tags: ['</em>'],
      require_field_match: true,
      fields: Object.fromEntries(
        textFields.flatMap((field) =>
          probes[field].length
            ? [
                [
                  field,
                  {
                    type: 'unified',
                    fragment_size: 128,
                    number_of_fragments: MATCH_EVIDENCE_LIMITS.reasons,
                    highlight_query: { bool: { should: probes[field], minimum_should_match: 1 } },
                  },
                ],
              ]
            : [],
        ),
      ),
    },
    queryBinding: createHash('sha256').update(JSON.stringify(compiled.query)).digest('hex'),
    names,
  };
}

export type EngineMatchEvidence = Readonly<{
  matched: readonly string[];
  highlight?: unknown;
  malformed?: boolean;
}>;

export function readEngineMatchEvidence(
  matched: unknown,
  highlight: unknown,
  plan: MatchEvidenceQuery,
): EngineMatchEvidence {
  if (
    !Array.isArray(matched) ||
    matched.length > 256 ||
    !matched.every((value) => typeof value === 'string' && value.length <= 128) ||
    new Set(matched).size !== matched.length
  )
    return { matched: [], malformed: true };
  const admittedNames = new Set([...plan.names.names, ...plan.names.descriptions]);
  const admittedMatches = matched.filter((value) => admittedNames.has(value));
  if (highlight === undefined) return { matched: admittedMatches };
  if (!highlight || typeof highlight !== 'object' || Array.isArray(highlight))
    return { matched: admittedMatches, malformed: true };
  const fields = highlight as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'names' && key !== 'descriptions'))
    return { matched: admittedMatches, malformed: true };
  const copied: Record<string, string[]> = {};
  let bytes = 0;
  for (const key of ['names', 'descriptions'] as const) {
    const fragments = fields[key];
    if (fragments === undefined) continue;
    if (
      !Array.isArray(fragments) ||
      fragments.length > MATCH_EVIDENCE_LIMITS.reasons ||
      !fragments.every(
        (value) =>
          typeof value === 'string' &&
          value.isWellFormed() &&
          Buffer.byteLength(value, 'utf8') <= MATCH_EVIDENCE_LIMITS.fragmentBytes,
      )
    )
      return { matched: admittedMatches, malformed: true };
    for (const fragment of fragments) bytes += Buffer.byteLength(fragment, 'utf8');
    copied[key] = [...fragments];
  }
  if (bytes > 2 * MATCH_EVIDENCE_LIMITS.reasons * MATCH_EVIDENCE_LIMITS.fragmentBytes)
    return { matched: admittedMatches, malformed: true };
  return { matched: admittedMatches, highlight: copied };
}

type Fragment = { text: string; spans: { start: number; end: number }[] };

function decodeEntity(value: string): string | undefined {
  if (value === '&amp;') return '&';
  if (value === '&lt;') return '<';
  if (value === '&gt;') return '>';
  if (value === '&quot;') return '"';
  if (value === '&#39;' || value === '&apos;') return "'";
  const numeric = /^&#(?:x([0-9a-f]{1,6})|(\d{1,7}));$/i.exec(value);
  if (!numeric) return undefined;
  const point = numeric[1] ? Number.parseInt(numeric[1], 16) : Number(numeric[2]);
  if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined;
  return String.fromCodePoint(point);
}

/** Parse only the server-owned <em> markers and standard escaped text; raw engine markup is never serialized. */
function parseFragment(value: unknown): Fragment | undefined {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, 'utf8') > MATCH_EVIDENCE_LIMITS.fragmentBytes
  )
    return undefined;
  let text = '';
  let open: number | undefined;
  const spans: { start: number; end: number }[] = [];
  for (let index = 0; index < value.length;) {
    if (value.startsWith('<em>', index)) {
      if (open !== undefined) return undefined;
      open = text.length;
      index += 4;
      continue;
    }
    if (value.startsWith('</em>', index)) {
      if (open === undefined || open === text.length) return undefined;
      spans.push({ start: open, end: text.length });
      open = undefined;
      index += 5;
      continue;
    }
    if (value[index] === '<') return undefined;
    if (value[index] === '&') {
      const end = value.indexOf(';', index + 1);
      if (end < 0 || end - index > 12) return undefined;
      const decoded = decodeEntity(value.slice(index, end + 1));
      if (decoded === undefined) return undefined;
      text += decoded;
      index = end + 1;
      continue;
    }
    const point = value.codePointAt(index);
    if (point === undefined) return undefined;
    const character = String.fromCodePoint(point);
    text += character;
    index += character.length;
  }
  if (open !== undefined || text.length === 0 || spans.length === 0 || spans.length > MATCH_EVIDENCE_LIMITS.spans)
    return undefined;
  if (!text.isWellFormed() || Buffer.byteLength(text, 'utf8') > MATCH_EVIDENCE_LIMITS.textBytes) return undefined;
  if (
    spans.some(
      ({ start, end }) =>
        start < 0 ||
        end > text.length ||
        start >= end ||
        (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]!)) ||
        (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)),
    )
  )
    return undefined;
  return { text, spans };
}

type CandidateSource = { field: MatchEvidenceField; language: string; value: string };

function currentSources(subject: IndexedSubject): CandidateSource[] | undefined {
  const values: CandidateSource[] = [
    ...subject.labels.map(({ language, value }) => ({ field: 'title' as const, language, value })),
    ...subject.aliases.map(({ language, value }) => ({ field: 'alias' as const, language, value })),
    ...subject.descriptions.map(({ language, value }) => ({ field: 'description' as const, language, value })),
  ];
  if (values.length > MATCH_EVIDENCE_LIMITS.sourceValues) return;
  let bytes = 0;
  for (const value of values) {
    if (typeof value.value !== 'string' || !value.value.isWellFormed() || !languageTag.test(value.language)) return;
    bytes += Buffer.byteLength(value.value, 'utf8');
    if (bytes > MATCH_EVIDENCE_LIMITS.sourceBytes) return;
  }
  return values;
}

/** Project only engine-highlighted excerpts that map to one current public source value and language. */
export function projectMatchEvidence(
  subject: IndexedSubject,
  candidate: EngineMatchEvidence | undefined,
  plan: MatchEvidenceQuery | undefined,
): MatchEvidence {
  if (!plan) return { state: 'absent' };
  if (!candidate || candidate.malformed) return { state: 'unavailable' };
  const matched = new Set(candidate.matched);
  if (matched.size !== candidate.matched.length) return { state: 'unavailable' };
  const sources = currentSources(subject);
  if (!sources) return { state: 'unavailable' };
  const highlight = candidate.highlight;
  if (!highlight || typeof highlight !== 'object' || Array.isArray(highlight)) return { state: 'unavailable' };
  const fields = highlight as Record<string, unknown>;
  const reasons: MatchEvidenceReason[] = [];
  let certifiedFields = 0;
  for (const [engineField, publicField] of [
    ['names', 'title'],
    ['descriptions', 'description'],
  ] as const) {
    if (!plan.names[engineField].some((name) => matched.has(name))) continue;
    certifiedFields++;
    const fragments = fields[engineField];
    if (
      !Array.isArray(fragments) ||
      fragments.length < 1 ||
      fragments.length > MATCH_EVIDENCE_LIMITS.reasons ||
      reasons.length + fragments.length > MATCH_EVIDENCE_LIMITS.reasons
    )
      return { state: 'unavailable' };
    for (const rawFragment of fragments) {
      const fragment = parseFragment(rawFragment);
      if (!fragment) return { state: 'unavailable' };
      const candidates = sources.filter(
        (source) =>
          (engineField === 'names'
            ? source.field === 'title' || source.field === 'alias'
            : source.field === publicField) && source.value.includes(fragment.text),
      );
      const identities = new Map(
        candidates.map((source) => [`${source.field}\0${source.language}\0${source.value}`, source]),
      );
      if (identities.size !== 1) return { state: 'unavailable' };
      const source = [...identities.values()][0]!;
      reasons.push({ field: source.field, language: source.language, text: fragment.text, spans: fragment.spans });
    }
  }
  if (certifiedFields === 0 || reasons.length === 0 || reasons.length > MATCH_EVIDENCE_LIMITS.reasons)
    return { state: 'unavailable' };
  const identities = new Set(reasons.map((reason) => `${reason.field}\0${reason.language}\0${reason.text}`));
  if (identities.size !== reasons.length) return { state: 'unavailable' };
  return {
    state: 'current',
    source: { id: subject.id, revision: subject.securityRevision },
    query: plan.queryBinding,
    reasons,
  };
}

export function boundMatchEvidencePage<T extends { matchEvidence: MatchEvidence }>(hits: readonly T[]): T[] {
  const result = hits.map((hit) => ({ ...hit }));
  let bytes = 0;
  try {
    for (const hit of result) {
      bytes += Buffer.byteLength(JSON.stringify(hit.matchEvidence), 'utf8');
      if (bytes > MATCH_EVIDENCE_LIMITS.pageBytes)
        return result.map((item) => ({
          ...item,
          matchEvidence: item.matchEvidence.state === 'current' ? { state: 'unavailable' } : item.matchEvidence,
        }));
    }
  } catch {
    return result.map((item) => ({
      ...item,
      matchEvidence: item.matchEvidence.state === 'current' ? { state: 'unavailable' } : item.matchEvidence,
    }));
  }
  return result;
}
