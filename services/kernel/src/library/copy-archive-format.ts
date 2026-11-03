import { ProblemError } from '../http/problem.ts';
import { parseStrictJson } from '../http/strict-json.ts';
import { routeOf } from '../route/route.ts';
import { exportSections } from './library-export-source.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';

/** Admission limits, independent of any eventual native copy command. */
export const COPY_ARCHIVE_LIMITS = {
  bytes: 32 * 1024 * 1024,
  records: 100_000,
  holdings: 4096,
  depth: 16,
  recordBytes: 66_000,
  evidenceBytes: 32 * 1024 * 1024,
  page: 10,
  cleanup: 100,
  lifetimeDays: 7,
} as const;

export type ArchivedHolding = {
  section: 'holdings';
  copy_id: string;
  subject_id: string;
  subject_id_reference: { id: string; href: string };
  kind: string | null;
  status: string;
  library_profile_pin: LibraryProfilePin | null;
  kind_profile_pin: LibraryProfilePin | null;
  status_profile_pin: LibraryProfilePin | null;
  location: string | null;
  source: string | null;
  acquired_on: string | null;
  disposed_on: string | null;
  note: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type CopyArchiveManifest = {
  format: 'https://rezics.com/formats/library-export';
  version: 1;
  exportId: string;
  capturedAt: string;
  expiresAt: string;
  privacy: 'private';
  completeness: 'supported-native-facts';
  sections: string[];
  omissions: Record<string, string>;
  fullExport: false;
  rows: number;
  recordBytes: number;
};
export type ArchiveSectionCoverage = {
  section: string;
  records: number;
  support: 'evidence-only' | 'unsupported';
};
export type ParsedCopyArchive = {
  manifest: CopyArchiveManifest;
  coverage: ArchiveSectionCoverage[];
  holdings: { ordinal: number; evidence: ArchivedHolding }[];
};

function invalid(): never {
  throw new ProblemError('invalid_request');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))) invalid();
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max * 2 &&
    value.isWellFormed() &&
    !value.includes('\u0000') &&
    [...value].length <= max
  );
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}
function stamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function date(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reject excessive nesting before native parsing allocates an object graph. */
function boundedDepth(text: string) {
  let depth = 0,
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      if (++depth > COPY_ARCHIVE_LIMITS.depth) invalid();
    } else if (c === '}' || c === ']') depth--;
  }
}

function holding(value: Record<string, unknown>): ArchivedHolding {
  exact(value, [
    'section',
    'copy_id',
    'subject_id',
    'subject_id_reference',
    'kind',
    'status',
    'library_profile_pin',
    'kind_profile_pin',
    'status_profile_pin',
    'location',
    'source',
    'acquired_on',
    'disposed_on',
    'note',
    'revision',
    'created_at',
    'updated_at',
  ]);
  if (
    !uuid(value.copy_id) ||
    !uuid(value.subject_id) ||
    !(value.kind === null || text(value.kind, 200)) ||
    !text(value.status, 200) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    Number(value.revision) > 2_147_483_647 ||
    !stamp(value.created_at) ||
    !stamp(value.updated_at) ||
    !date(value.acquired_on) ||
    !date(value.disposed_on)
  )
    invalid();
  for (const [key, limit] of [
    ['note', 1000],
    ['location', 200],
    ['source', 200],
  ] as const)
    if (value[key] !== null && !text(value[key], limit)) invalid();
  const reference = object(value.subject_id_reference);
  exact(reference, ['id', 'href']);
  if (reference.id !== value.subject_id || reference.href !== `https://rezics.com/subjects/${value.subject_id}`)
    invalid();
  for (const field of ['library_profile_pin', 'kind_profile_pin', 'status_profile_pin'] as const) {
    try {
      decodeLibraryProfilePin(value[field]);
    } catch {
      invalid();
    }
    if (
      value[field] !== null &&
      Object.values(object(value[field])).some(
        (v) => typeof v === 'string' && (!v.isWellFormed() || v.includes('\u0000')),
      )
    )
      invalid();
  }
  // Evidence only: no UUID, pin, revision or timestamp here is a command operand.
  return value as ArchivedHolding;
}

/** Parse the installed Web artifact, never a synthetic row-list or an unfinished page. */
export function parseCopyArchive(bytes: Uint8Array): ParsedCopyArchive {
  if (bytes.byteLength > COPY_ARCHIVE_LIMITS.bytes) throw new ProblemError('content_too_large');
  let raw: unknown;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    boundedDepth(source);
    raw = parseStrictJson(source);
  } catch {
    return invalid();
  }
  const archive = object(raw);
  exact(archive, ['manifest', 'records']);
  const m = object(archive.manifest);
  exact(m, [
    'format',
    'version',
    'exportId',
    'capturedAt',
    'expiresAt',
    'privacy',
    'completeness',
    'sections',
    'omissions',
    'fullExport',
    'rows',
    'recordBytes',
  ]);
  if (
    m.format !== 'https://rezics.com/formats/library-export' ||
    m.version !== 1 ||
    m.privacy !== 'private' ||
    m.completeness !== 'supported-native-facts' ||
    m.fullExport !== false ||
    !uuid(m.exportId) ||
    !stamp(m.capturedAt) ||
    !stamp(m.expiresAt) ||
    Date.parse(m.expiresAt) <= Date.parse(m.capturedAt) ||
    !Number.isSafeInteger(m.rows) ||
    Number(m.rows) < 0 ||
    Number(m.rows) > COPY_ARCHIVE_LIMITS.records ||
    !Number.isSafeInteger(m.recordBytes) ||
    Number(m.recordBytes) < 0 ||
    Number(m.recordBytes) > COPY_ARCHIVE_LIMITS.bytes
  )
    invalid();
  // v1 has no section counters or availability flags: missing declared sections are incomplete captures.
  const sections = m.sections;
  if (
    !Array.isArray(sections) ||
    sections.length !== exportSections.length ||
    new Set(sections).size !== exportSections.length ||
    exportSections.some((s) => !sections.includes(s))
  )
    invalid();
  const omissions = object(m.omissions);
  if (Object.keys(omissions).length > 32 || Object.entries(omissions).some(([k, v]) => !text(k, 200) || !text(v, 2000)))
    invalid();
  if (!Array.isArray(archive.records) || archive.records.length !== m.rows) invalid();
  const coverage = new Map<string, number>(exportSections.map((section) => [section, 0]));
  const holdings: ParsedCopyArchive['holdings'] = [];
  const ids = new Set<string>();
  let recordBytes = 0,
    retainedBytes = Buffer.byteLength(JSON.stringify(m), 'utf8');
  for (let ordinal = 0; ordinal < archive.records.length; ordinal++) {
    const record = object(archive.records[ordinal]);
    if (typeof record.section !== 'string' || !coverage.has(record.section)) invalid();
    coverage.set(record.section, coverage.get(record.section)! + 1);
    const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (size > COPY_ARCHIVE_LIMITS.recordBytes) invalid();
    recordBytes += size;
    if (record.section !== 'holdings') continue;
    const evidence = holding(record);
    if (ids.has(evidence.copy_id) || holdings.length >= COPY_ARCHIVE_LIMITS.holdings) invalid();
    ids.add(evidence.copy_id);
    retainedBytes += size;
    if (retainedBytes > COPY_ARCHIVE_LIMITS.evidenceBytes) invalid();
    holdings.push({ ordinal, evidence });
  }
  if (recordBytes !== m.recordBytes) invalid();
  return {
    manifest: m as CopyArchiveManifest,
    coverage: [...coverage].map(([section, records]) => ({
      section,
      records,
      support: section === 'holdings' ? 'evidence-only' : 'unsupported',
    })),
    holdings,
  };
}
