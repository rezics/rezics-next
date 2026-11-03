import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const VNDB_LIMITS = {
  bytes: 2 * 1024 * 1024,
  wireBytes: 12 * 1024 * 1024 + 64,
  depth: 32,
  rows: 5000,
  evidenceBytes: 16 * 1024 * 1024,
  page: 8,
  uploads: 4,
  lifetimeMs: 86400000,
  applyMs: 5000,
} as const;
export class VndbInvalid extends Error {
  constructor() {
    super('Invalid or oversized VNDB version 1.0 export');
  }
}
type Node = Record<string, unknown>;
export type SourceValue = {
  kind: 'missing' | 'unknown' | 'invalid' | 'value';
  raw: string | null;
  value?: string | number;
  precision?: 'year' | 'month' | 'day';
  scale?: { min: number; max: number; step: number };
};
export type VndbRow = {
  ordinal: number;
  kind: 'vn' | 'retained';
  identifier: { provider: 'vndb'; kind: 'vn'; value: string } | null;
  title: string;
  labels: string[];
  suggestedRole: string | null;
  fields: Record<string, SourceValue>;
  retainedReason: string;
  evidence: unknown;
};
const children = (nodes: Node[], tag: string): Node[][] =>
  nodes.filter((n) => Array.isArray(n[tag])).map((n) => n[tag] as Node[]);
const attr = (node: Node, key: string): string | null =>
  (node[':@'] as Record<string, string> | undefined)?.[key] ?? null;
const text = (nodes: Node[]): string =>
  nodes
    .map((n) =>
      typeof n['#text'] === 'string'
        ? n['#text']
        : Object.entries(n)
            .filter(([k, v]) => k !== ':@' && Array.isArray(v))
            .map(([, v]) => text(v as Node[]))
            .join(''),
    )
    .join('');
const field = (nodes: Node[], tag: string): string | null => {
  const node = children(nodes, tag)[0];
  return node ? text(node).trim() : null;
};
function value(raw: string | null): SourceValue {
  return {
    kind: raw === null ? 'missing' : raw === '' || raw === 'unknown' ? 'unknown' : 'value',
    raw,
    ...(raw === null ? {} : { value: raw }),
  };
}
function date(raw: string | null): SourceValue {
  const result = value(raw);
  if (result.kind !== 'value') return result;
  if (raw === '0000-00-00') return { kind: 'unknown', raw };
  const normalized = raw!.replace(/-00(?:-00)?$/, '');
  const full =
    normalized.length === 4 ? `${normalized}-01-01` : normalized.length === 7 ? `${normalized}-01` : normalized;
  const parsed = new Date(`${full}T00:00:00Z`);
  if (
    !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(normalized) ||
    normalized.startsWith('0000') ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== full
  )
    return { kind: 'invalid', raw };
  return {
    kind: 'value',
    raw,
    value: normalized,
    precision: normalized.length === 4 ? 'year' : normalized.length === 7 ? 'month' : 'day',
  };
}
function vote(raw: string | null): SourceValue {
  const result = value(raw);
  if (result.kind !== 'value') return result;
  const score = Number(raw);
  return /^\d+(?:\.\d)?$/.test(raw!) && score >= 1 && score <= 10
    ? { kind: 'value', raw, value: score, scale: { min: 1, max: 10, step: 0.1 } }
    : { kind: 'invalid', raw };
}

/** Derived from legacy-final's VNDB adapter and contract/bounds/XML helpers.
 * Lexical depth admission precedes the parser, including for malformed documents. */
export function parseVndb(xml: string): VndbRow[] {
  if (Buffer.byteLength(xml) > VNDB_LIMITS.bytes || /<!DOCTYPE|<!ENTITY/i.test(xml) || xml.includes('\u0000'))
    throw new VndbInvalid();
  let depth = 0;
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
  for (const match of xml.matchAll(tokens)) {
    const tag = match[0];
    if (tag.startsWith('<!') || tag.startsWith('<?')) continue;
    if (tag.startsWith('</')) depth--;
    else {
      if (depth + 1 > VNDB_LIMITS.depth) throw new VndbInvalid();
      if (!tag.endsWith('/>')) depth++;
    }
    if (depth < 0) throw new VndbInvalid();
  }
  if (depth !== 0 || XMLValidator.validate(xml) !== true) throw new VndbInvalid();
  let document: Node[];
  try {
    document = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      commentPropName: '#comment',
      cdataPropName: '#cdata',
    }).parse(xml) as Node[];
  } catch {
    throw new VndbInvalid();
  }
  const root = document.find((n) => Array.isArray(n['vndb-export']));
  if (!root || attr(root, 'version') !== '1.0') throw new VndbInvalid();
  const rows: VndbRow[] = [];
  const add = (node: Node, kind: VndbRow['kind'], container: string) => {
    if (rows.length >= VNDB_LIMITS.rows - 1) throw new VndbInvalid();
    const nodes = (node[Object.keys(node).find((k) => k !== ':@')!] ?? []) as Node[];
    const identifier = attr(node, 'id');
    if (kind === 'vn' && (!identifier || !/^v[1-9][0-9]*$/.test(identifier))) throw new VndbInvalid();
    const labels = nodes.filter((n) => Array.isArray(n.label)).map((n) => attr(n, 'label') ?? text(n.label as Node[]));
    const progress = nodes.find((n) => Array.isArray(n.progress));
    const roles: Record<string, string> = {
      Playing: 'active',
      Finished: 'completed',
      Stalled: 'paused',
      Dropped: 'dropped',
      Wishlist: 'planned',
    };
    const suggested = [...new Set(labels.map((l) => roles[l]).filter(Boolean))];
    rows.push({
      ordinal: rows.length,
      kind,
      identifier: kind === 'vn' ? { provider: 'vndb', kind: 'vn', value: identifier! } : null,
      title: field(nodes, 'title') ?? '',
      labels,
      suggestedRole: suggested.length === 1 ? suggested[0]! : null,
      fields: {
        status: value(labels.length ? labels.join(', ') : null),
        score: vote(field(nodes, 'vote')),
        started: date(field(nodes, 'started')),
        finished: date(field(nodes, 'finished')),
        progress: value(field(nodes, 'progress')),
        progressMeasure: value(
          (progress ? attr(progress, 'unit') : null) ?? attr(node, 'progress_unit') ?? field(nodes, 'progress-unit'),
        ),
        notes: value(field(nodes, 'notes') ?? field(nodes, 'note')),
        privacy: value(attr(node, 'private') ?? field(nodes, 'private')),
      },
      retainedReason:
        kind === 'vn'
          ? 'Only an explicitly selected released entry state can be applied; all other source fields remain private evidence.'
          : `${container}: no native Library admission; retained privately, never published.`,
      evidence: node,
    });
  };
  for (const container of root['vndb-export'] as Node[]) {
    if (Array.isArray(container.vns)) {
      for (const node of container.vns as Node[]) {
        if (Array.isArray(node.vn)) add(node, 'vn', 'vns');
        else if (!Object.hasOwn(node, '#text')) add(node, 'retained', 'vns');
      }
      // Container attributes, comments and text remain in the original upload.
    } else if (!Object.hasOwn(container, '#text')) {
      const name = Object.keys(container).find((k) => k !== ':@')!;
      const entries = container[name];
      if (['reviews', 'length-votes', 'releases'].includes(name) && Array.isArray(entries)) {
        const elements = (entries as Node[]).filter((n) => !Object.hasOwn(n, '#text'));
        for (const entry of elements) add(entry, 'retained', name);
        if (!elements.length) add(container, 'retained', name);
      } else add(container, 'retained', name);
    }
  }
  rows.push({
    ordinal: rows.length,
    kind: 'retained',
    identifier: null,
    title: '',
    labels: [],
    suggestedRole: null,
    fields: {},
    retainedReason: 'Export metadata and exact original XML remain private source evidence.',
    evidence: { attributes: root[':@'] ?? {} },
  });
  if (Buffer.byteLength(JSON.stringify(rows)) > VNDB_LIMITS.evidenceBytes) throw new VndbInvalid();
  return rows;
}
