import { ProblemError } from '../http/problem-error.ts';
import { parseStrictJson } from '../http/strict-json.ts';
import { routeOf } from '../route/route.ts';
import { sectionsForVersion, LIBRARY_EXPORT_FORMAT } from './library-export-format.ts';
import { decodeLibraryArchive, ArchiveValidationError } from './library-archive.ts';
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
type CopyArchiveManifestBase = {
  format: typeof LIBRARY_EXPORT_FORMAT;
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
/** Original manifests and all section totals remain evidence, including unsupported provider rows. */
export type CopyArchiveManifest = CopyArchiveManifestBase &
  (
    | { version: 1 }
    | {
        version: 2;
        coverage: 'private-library-owner-facts-v2';
        sectionTotals: Record<string, { rows: number; recordBytes: number }>;
      }
    | {
        version: 4;
        coverage: 'private-library-owner-facts-v4';
        sectionTotals: Record<string, { rows: number; recordBytes: number }>;
      }
    | {
        version: 3;
        coverage: 'private-library-owner-facts-v3';
        sectionTotals: Record<string, { rows: number; recordBytes: number }>;
      }
  );
export type ArchiveSectionCoverage = {
  section: string;
  records: number;
  /** Absent on uploads retained before per-section byte accounting was installed. */
  recordBytes?: number;
  support: 'evidence-only' | 'unsupported';
};
export type ArchivedProgressMeasure = { unit: string; amount: string | null; total: string | null };
export type ArchivedProgressSession = {
  section: 'sessions';
  session_id: string;
  subject_id: string;
  subject_id_reference: { id: string; href: string };
  version_subject_id: string | null;
  version_subject_id_reference?: { id: string; href: string };
  mode: string;
  unit: string;
  total: string | null;
  amount: string | null;
  additional_measures?: ArchivedProgressMeasure[];
  locator: string | null;
  position: string | null;
  completed_unit_count: number;
  state: string;
  revision: number;
  library_profile_pin: unknown;
  started_at: string;
  completed_at: string | null;
  last_changed_at: string;
};
export type ArchivedProgressUnit = {
  section: 'units';
  session_id: string;
  unit_id: string;
  added_at: string;
};
export type ParsedCopyArchive = {
  manifest: CopyArchiveManifest;
  coverage: (ArchiveSectionCoverage & { recordBytes: number })[];
  holdings: { ordinal: number; evidence: ArchivedHolding }[];
  progress: {
    ordinal: number;
    evidence: ArchivedProgressSession | ArchivedProgressUnit;
    sourceSessionId: string;
    sourceUnitId: string | null;
  }[];
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
function decimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 19 && /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value);
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

function subjectReference(value: Record<string, unknown>, key: string) {
  const id = value[key],
    reference = value[`${key}_reference`];
  if (id === null) return reference === undefined;
  if (!uuid(id)) return false;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false;
  const ref = reference as Record<string, unknown>;
  return Object.keys(ref).length === 2 && ref.id === id && ref.href === `https://rezics.com/subjects/${id}`;
}

function progressSession(value: Record<string, unknown>): ArchivedProgressSession {
  const required = [
    'section',
    'session_id',
    'subject_id',
    'subject_id_reference',
    'version_subject_id',
    'mode',
    'unit',
    'total',
    'amount',
    'locator',
    'position',
    'completed_unit_count',
    'state',
    'revision',
    'library_profile_pin',
    'started_at',
    'completed_at',
    'last_changed_at',
  ];
  const optional = ['version_subject_id_reference', 'additional_measures'];
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    !uuid(value.session_id) ||
    !uuid(value.subject_id) ||
    !subjectReference(value, 'subject_id') ||
    !subjectReference(value, 'version_subject_id') ||
    !(value.version_subject_id === null || uuid(value.version_subject_id)) ||
    !text(value.mode, 200) ||
    !text(value.unit, 200) ||
    !(value.total === null || decimal(value.total)) ||
    !(value.amount === null || decimal(value.amount)) ||
    !(value.locator === null || text(value.locator, 4096)) ||
    !(value.position === null || decimal(value.position)) ||
    !Number.isInteger(value.completed_unit_count) ||
    Number(value.completed_unit_count) < 0 ||
    Number(value.completed_unit_count) > 20_000 ||
    !text(value.state, 64) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    Number(value.revision) > 2_147_483_647 ||
    !(
      value.library_profile_pin === null ||
      (!!value.library_profile_pin &&
        typeof value.library_profile_pin === 'object' &&
        !Array.isArray(value.library_profile_pin))
    ) ||
    !stamp(value.started_at) ||
    !(value.completed_at === null || stamp(value.completed_at)) ||
    !stamp(value.last_changed_at)
  )
    invalid();
  if (Object.hasOwn(value, 'version_subject_id_reference') !== (value.version_subject_id !== null)) invalid();
  if (Object.hasOwn(value, 'additional_measures')) {
    const measures = value.additional_measures;
    if (!Array.isArray(measures) || measures.length > 7) invalid();
    const seen = new Set<string>();
    for (const candidate of measures as unknown[]) {
      const measure = object(candidate);
      exact(measure, ['unit', 'amount', 'total']);
      const unit = measure.unit;
      if (typeof unit !== 'string' || !text(unit, 200)) invalid();
      const admittedUnit = unit as string;
      if (
        !(measure.amount === null || decimal(measure.amount)) ||
        !(measure.total === null || decimal(measure.total)) ||
        seen.has(admittedUnit)
      )
        invalid();
      seen.add(admittedUnit);
    }
  }
  // Archived IDs, revisions and pins remain evidence; native commands create a new occurrence.
  return value as ArchivedProgressSession;
}

function progressUnit(value: Record<string, unknown>): ArchivedProgressUnit {
  exact(value, ['section', 'session_id', 'unit_id', 'added_at']);
  if (!uuid(value.session_id) || !text(value.unit_id, 128) || !stamp(value.added_at)) invalid();
  return value as ArchivedProgressUnit;
}

/** Recognize current envelopes without retaining or adopting their private payloads. */
function unsupportedCurrentRecord(value: Record<string, unknown>, version: 2 | 3 | 4) {
  switch (value.section) {
    case 'annotations':
      exact(value, [
        'section',
        'accountId',
        'subjectId',
        'entryIncarnationId',
        'libraryProfilePin',
        'annotationRevision',
        'note',
        'priority',
        'annotationUpdatedAt',
      ]);
      if (
        !uuid(value.accountId) ||
        !uuid(value.subjectId) ||
        !(value.entryIncarnationId === null || uuid(value.entryIncarnationId)) ||
        !Number.isSafeInteger(value.annotationRevision) ||
        Number(value.annotationRevision) < 1 ||
        !(value.note === null || text(value.note, 4096)) ||
        !(
          value.priority === null ||
          (Number.isInteger(value.priority) && Number(value.priority) >= 1 && Number(value.priority) <= 100)
        ) ||
        !(value.annotationUpdatedAt === null || stamp(value.annotationUpdatedAt))
      )
        invalid();
      break;
    case 'provenance':
      exact(value, ['section', 'accountId', 'subjectId', 'entryIncarnationId', 'libraryProfilePin', 'observation']);
      exact(object(value.observation), [
        'provider',
        'recordId',
        'revision',
        'privacy',
        'sourceCreated',
        'sourceUpdated',
        'recordedAt',
      ]);
      if (
        !uuid(value.accountId) ||
        !uuid(value.subjectId) ||
        !(value.entryIncarnationId === null || uuid(value.entryIncarnationId))
      )
        invalid();
      break;
    case 'journals': {
      exact(value, [
        'section',
        'accountId',
        'sessionId',
        'subjectId',
        'versionSubjectId',
        'state',
        'progressRevision',
        'libraryProfilePin',
        'startedAt',
        'completedAt',
        'lastChangedAt',
        'journal',
      ]);
      const journal = object(value.journal);
      exact(journal, [
        'sessionId',
        'revision',
        'startDate',
        'finishDate',
        'reflection',
        ...(version >= 3 ? ['assessment'] : []),
      ]);
      if (!uuid(value.sessionId) || journal.sessionId !== value.sessionId) invalid();
      if (
        !uuid(value.accountId) ||
        !uuid(value.subjectId) ||
        !(value.versionSubjectId === null || uuid(value.versionSubjectId)) ||
        !text(value.state, 64) ||
        !Number.isSafeInteger(value.progressRevision) ||
        Number(value.progressRevision) < 1 ||
        !Number.isSafeInteger(journal.revision) ||
        Number(journal.revision) < 0 ||
        !stamp(value.startedAt) ||
        !(value.completedAt === null || stamp(value.completedAt)) ||
        !(value.lastChangedAt === null || stamp(value.lastChangedAt)) ||
        !(journal.reflection === null || text(journal.reflection, 4096))
      )
        invalid();
      if (version >= 3) {
        const assessment = object(journal.assessment);
        exact(assessment, ['meaningRevision', 'units']);
        if (
          assessment.meaningRevision !== 1 ||
          !(
            assessment.units === null ||
            (Number.isInteger(assessment.units) && Number(assessment.units) >= 0 && Number(assessment.units) <= 20)
          )
        )
          invalid();
      }
      break;
    }
  }
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
  if (m.version !== 1 && m.version !== 2 && m.version !== 3 && m.version !== 4) invalid();
  const version = m.version as 1 | 2 | 3 | 4;
  // Current external files reach the common strict boundary before any supported-row selection.
  if (version === 4) {
    try {
      decodeLibraryArchive(bytes);
    } catch (error) {
      if (error instanceof ArchiveValidationError) return invalid();
      throw error;
    }
  }
  const installedSections: readonly string[] = sectionsForVersion(version);
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
    ...(version === 1 ? [] : ['coverage', 'sectionTotals']),
  ]);
  if (
    m.format !== LIBRARY_EXPORT_FORMAT ||
    (version !== 1 && m.coverage !== `private-library-owner-facts-v${version}`) ||
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
  // V1 keeps its fixed decoder; current versions preserve the producer's exact inventory order.
  const sections = m.sections;
  if (
    !Array.isArray(sections) ||
    sections.length !== installedSections.length ||
    new Set(sections).size !== installedSections.length ||
    installedSections.some((s, index) => (version === 1 ? !sections.includes(s) : sections[index] !== s))
  )
    invalid();
  const omissions = object(m.omissions);
  if (version !== 1)
    exact(omissions, ['trash', 'providerIdentifiers', 'personalImportEvidence', 'commerce', 'publication', 'reimport']);
  if (Object.keys(omissions).length > 32 || Object.entries(omissions).some(([k, v]) => !text(k, 200) || !text(v, 2000)))
    invalid();
  const totals = version === 1 ? null : object(m.sectionTotals);
  if (totals) {
    exact(totals, installedSections);
    for (const section of installedSections) {
      const total = object(totals[section]);
      exact(total, ['rows', 'recordBytes']);
      if (
        !Number.isSafeInteger(total.rows) ||
        Number(total.rows) < 0 ||
        Number(total.rows) > Number(m.rows) ||
        !Number.isSafeInteger(total.recordBytes) ||
        Number(total.recordBytes) < 0 ||
        Number(total.recordBytes) > Number(m.recordBytes)
      )
        invalid();
    }
  }
  const records = archive.records;
  if (!Array.isArray(records) || records.length !== m.rows) invalid();
  const archiveRecords = records as unknown[];
  const coverage = new Map(installedSections.map((section) => [section, { records: 0, recordBytes: 0 }]));
  const holdings: ParsedCopyArchive['holdings'] = [];
  const progress: ParsedCopyArchive['progress'] = [];
  const sessions = new Set<string>();
  const unitKeys = new Set<string>();
  const ids = new Set<string>();
  let recordBytes = 0,
    retainedBytes = Buffer.byteLength(JSON.stringify(m), 'utf8');
  for (let ordinal = 0; ordinal < archiveRecords.length; ordinal++) {
    const record = object(archiveRecords[ordinal]);
    const section = record.section;
    if (typeof section !== 'string' || !coverage.has(section)) invalid();
    const typedSection = section as string;
    const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (size > COPY_ARCHIVE_LIMITS.recordBytes) invalid();
    recordBytes += size;
    const sectionCoverage = coverage.get(typedSection)!;
    sectionCoverage.records++;
    sectionCoverage.recordBytes += size;
    if (typedSection === 'holdings') {
      const evidence = holding(record);
      if (ids.has(evidence.copy_id) || holdings.length >= COPY_ARCHIVE_LIMITS.holdings) invalid();
      ids.add(evidence.copy_id);
      retainedBytes += size;
      if (retainedBytes > COPY_ARCHIVE_LIMITS.evidenceBytes) invalid();
      holdings.push({ ordinal, evidence });
    } else if (typedSection === 'sessions') {
      const evidence = progressSession(record);
      if (sessions.has(evidence.session_id)) invalid();
      sessions.add(evidence.session_id);
      retainedBytes += size;
      if (retainedBytes > COPY_ARCHIVE_LIMITS.evidenceBytes) invalid();
      progress.push({ ordinal, evidence, sourceSessionId: evidence.session_id, sourceUnitId: null });
    } else if (typedSection === 'units') {
      const evidence = progressUnit(record);
      const key = `${evidence.session_id}/${evidence.unit_id}`;
      if (unitKeys.has(key)) invalid();
      unitKeys.add(key);
      retainedBytes += size;
      if (retainedBytes > COPY_ARCHIVE_LIMITS.evidenceBytes) invalid();
      progress.push({ ordinal, evidence, sourceSessionId: evidence.session_id, sourceUnitId: evidence.unit_id });
    } else if (version !== 1) {
      unsupportedCurrentRecord(record, version);
    }
  }
  if (progress.some((row) => row.evidence.section === 'units' && !sessions.has(row.sourceSessionId))) invalid();
  if (recordBytes !== m.recordBytes) invalid();
  if (totals)
    for (const [section, actual] of coverage) {
      const expected = object(totals[section]);
      if (actual.records !== expected.rows || actual.recordBytes !== expected.recordBytes) invalid();
    }
  return {
    manifest: m as CopyArchiveManifest,
    coverage: [...coverage].map(([section, counts]) => ({
      section,
      ...counts,
      support:
        section === 'holdings' || section === 'sessions' || section === 'units' ? 'evidence-only' : 'unsupported',
    })),
    holdings,
    progress,
  };
}
