import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ProblemError } from '../http/problem.ts';

export const MAL_LIMITS = {
  bytes: 2_097_152,
  wireBytes: 4_194_304,
  evidenceBytes: 12_582_912,
  rows: 500,
  page: 20,
  depth: 16,
  uploads: 3,
} as const;
export type MalValue = {
  kind: 'missing' | 'unknown' | 'invalid' | 'zero' | 'value';
  raw?: string;
  value?: string | number;
  precision?: 'year' | 'month' | 'day';
};
export type MalRow = {
  index: number;
  kind: 'anime' | 'manga';
  title: string;
  identifier: { namespace: string; source: string; value: string };
  status: MalValue;
  role: string | null;
  score: MalValue & { scale: { min: 1; max: 10; step: 1 } };
  progress: Record<string, MalValue>;
  dates: Record<string, MalValue>;
  notes: MalValue;
  tags: MalValue;
  repeats: MalValue;
  privacy: MalValue;
  timestamps: Record<string, MalValue>;
  fields: Record<string, string>;
  retained: { field: string; reason: string }[];
};
export function malInvalid(reason: string, row?: number): never {
  throw new ProblemError('invalid_request', { detail: `MAL${row === undefined ? '' : ` row ${row + 1}`}: ${reason}` });
}
function text(raw: string | undefined): MalValue {
  return raw === undefined ? { kind: 'missing' } : { kind: raw === '' ? 'unknown' : 'value', raw, value: raw };
}
function count(raw: string | undefined, max = Number.MAX_SAFE_INTEGER): MalValue {
  const v = text(raw);
  if (raw === undefined || v.kind !== 'value') return v;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw!) || !Number.isSafeInteger(n) || n > max) return { raw, kind: 'invalid' };
  return { raw, kind: n === 0 ? 'zero' : 'value', value: n };
}
export function malDate(raw: string | undefined): MalValue {
  const v = text(raw);
  if (raw === undefined || v.kind !== 'value') return v;
  if (raw === '0000-00-00') return { raw, kind: 'unknown' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw!);
  if (!m) return { raw, kind: 'invalid' };
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3]);
  if (mo > 12 || d > 31) return { raw, kind: 'invalid' };
  if (!y || (!mo && d)) return { raw, kind: 'unknown' };
  if (!mo) return { raw, kind: 'value', value: m[1]!, precision: 'year' };
  if (!d) return { raw, kind: 'value', value: raw!.slice(0, 7), precision: 'month' };
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d > days[mo - 1]! ? { raw, kind: 'invalid' } : { raw, kind: 'value', value: raw, precision: 'day' };
}
const roles: Record<string, string> = {
  Watching: 'active',
  Reading: 'active',
  Completed: 'completed',
  'On-Hold': 'paused',
  Dropped: 'dropped',
  'Plan to Watch': 'planned',
  'Plan to Read': 'planned',
  '1': 'active',
  '2': 'completed',
  '3': 'paused',
  '4': 'dropped',
  '6': 'planned',
};
type Node = Record<string, unknown>;
/** Uploaded XML stays inert; raw evidence is stored privately, never interpolated in failures. */
export function parseMal(xml: string): MalRow[] {
  if (!xml.isWellFormed() || Buffer.byteLength(xml) > MAL_LIMITS.bytes)
    malInvalid('upload exceeds 2 MiB or has invalid text');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) malInvalid('DTD and entity declarations are forbidden');
  // Bound nesting before the parser/validator can allocate a recursive tree. Comments and CDATA are inert.
  let depth = 0;
  for (const token of xml.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>/g)) {
    const tag = token[0];
    if (/^<[!?]/.test(tag)) continue;
    depth += tag.startsWith('</') ? -1 : tag.endsWith('/>') ? 0 : 1;
    if (depth > MAL_LIMITS.depth) malInvalid('XML nesting exceeds 16');
  }
  if (XMLValidator.validate(xml) !== true) malInvalid('malformed XML');
  let tree: Node[];
  try {
    tree = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: false,
      processEntities: true,
    }).parse(xml);
  } catch {
    return malInvalid('malformed XML');
  }
  const roots = tree.filter((n) => !Object.keys(n)[0]!.startsWith('?') && !('#text' in n));
  if (roots.length !== 1 || !Array.isArray(roots[0]!.myanimelist)) malInvalid('expected myanimelist root');
  const rows: MalRow[] = [],
    ids = new Set<string>();
  for (const node of roots[0]!.myanimelist as Node[]) {
    const kind = Object.keys(node)[0];
    if (kind !== 'anime' && kind !== 'manga') continue; // Export metadata remains in the private original XML.
    const index = rows.length;
    if (index >= MAL_LIMITS.rows) malInvalid('export exceeds 500 rows');
    const fields: Record<string, string> = Object.create(null);
    for (const field of node[kind] as Node[]) {
      const key = Object.keys(field)[0]!;
      if (key === '#text') continue;
      if (Object.hasOwn(fields, key)) malInvalid('duplicate field', index);
      const leaves = field[key] as Node[];
      if (!Array.isArray(leaves) || leaves.some((n) => Object.keys(n).some((k) => k !== '#text')))
        malInvalid('expected scalar row field', index);
      fields[key] = leaves.map((n) => String(n['#text'] ?? '')).join('');
    }
    const anime = kind === 'anime';
    const id = fields[anime ? 'series_animedb_id' : 'manga_mangadb_id']?.trim();
    const title = fields[anime ? 'series_title' : 'manga_title']?.trim();
    if (!id || !/^[1-9][0-9]{0,14}$/.test(id)) malInvalid('invalid or missing identifier', index);
    if (!title) malInvalid('missing title', index);
    if (ids.has(`${kind}:${id}`)) malInvalid('duplicate identifier', index);
    ids.add(`${kind}:${id}`);
    const status = text(fields.my_status),
      role = roles[fields.my_status?.trim() ?? ''] ?? null;
    rows.push({
      index,
      kind,
      title,
      identifier: { namespace: `https://myanimelist.net/${kind}`, source: `mal_${kind}`, value: id },
      fields,
      status: role || status.kind !== 'value' ? status : { ...status, kind: 'invalid' },
      role,
      score: { ...count(fields.my_score, 10), scale: { min: 1, max: 10, step: 1 } },
      progress: Object.fromEntries(
        (anime ? ['my_watched_episodes'] : ['my_read_chapters', 'my_read_volumes']).map((k) => [k, count(fields[k])]),
      ),
      dates: { started: malDate(fields.my_start_date), finished: malDate(fields.my_finish_date) },
      notes: text(fields.my_comments),
      tags: text(fields.my_tags),
      repeats: count(fields[anime ? 'my_times_watched' : 'my_times_read']),
      privacy: text(fields.my_privacy),
      timestamps: Object.fromEntries(
        Object.keys(fields)
          .filter((k) => /updated|timestamp|last_updated/.test(k))
          .map((k) => [k, text(fields[k])]),
      ),
      retained: Object.keys(fields)
        .filter((k) => k !== 'my_status')
        .map((field) => ({
          field,
          reason:
            field === 'my_comments'
              ? 'private-note-only'
              : field === 'my_score'
                ? 'no-native-vote-admission'
                : /episodes|chapters|volumes|times_/.test(field)
                  ? 'no-dated-session-or-native-measure-admission'
                  : 'private-source-evidence',
        })),
    });
  }
  if (!rows.length) malInvalid('export has no anime or manga rows');
  return rows;
}
