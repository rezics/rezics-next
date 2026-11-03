import {
  exportSectionsV2,
  LIBRARY_EXPORT_FORMAT,
  LIBRARY_EXPORT_LIMITS,
  sectionsForVersion,
  type LibraryArchiveManifest,
  type LibraryExportSection,
  type LibraryExportVersion,
} from './library-export-format.ts';

/** Consumer bounds, fixed before parsing. No upload, permission or effect is admitted here. */
export const LIBRARY_ARCHIVE_LIMITS = {
  ...LIBRARY_EXPORT_LIMITS,
  // Compact producer records plus commas, the final manifest and bounded formatting whitespace.
  uploadBytes: 34 * 1024 * 1024,
  depth: 32,
  sections: exportSectionsV2.length,
} as const;
/** Installed private Collection recovery bounds; these are independent of each native command's own cap. */
export const LIBRARY_ARCHIVE_RECOVERY_LIMITS = {
  retainedUploadsPerOwner: 2,
  lifetimeMs: 24 * 60 * 60 * 1000,
  selectedCollections: 1,
  selectedOccurrences: 1_000,
  previewPage: 50,
  applyCommands: 25,
  cleanupRows: 100,
} as const;
export const archiveMergeSections = ['entries', 'labels', 'assignments', 'annotations', 'journals'] as const;
type MergeSection = (typeof archiveMergeSections)[number];
type ObjectValue = Record<string, unknown>;
export type ArchiveRecord = ObjectValue & { section: LibraryExportSection };
export type ArchiveCoverage = {
  section: LibraryExportSection;
  capture: 'present' | 'empty';
  treatment: 'requires-explicit-mapping' | 'retained-unsupported';
  rows: number;
};
export type LibraryArchive = {
  manifest: LibraryArchiveManifest;
  records: ArchiveRecord[];
  coverage: ArchiveCoverage[];
  /** Envelope and record validation never establishes current identity, state or label admission. */
  fullRestoration: false;
};
export type ArchiveValidationCode =
  | 'bounds'
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_envelope'
  | 'incomplete_capture'
  | 'inconsistent_manifest'
  | 'invalid_record'
  | 'duplicate_record'
  | 'duplicate_label';

/** Stable reasons contain neither source values nor private names, including JSON parser errors. */
export class ArchiveValidationError extends Error {
  constructor(readonly code: ArchiveValidationCode) {
    super(`Library archive: ${code}`);
    this.name = 'ArchiveValidationError';
  }
}
function fail(code: ArchiveValidationCode): never {
  throw new ArchiveValidationError(code);
}
function object(value: unknown, code: ArchiveValidationCode): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as ObjectValue;
}
function exactKeys(value: ObjectValue, required: readonly string[], optional: readonly string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Bound nesting and reject duplicate object keys before JSON.parse can collapse them. */
function inspectJson(text: string) {
  const stack: ({ kind: '{'; keys: Set<string> } | { kind: '[' })[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (i >= text.length) fail('invalid_json');
      let after = i + 1;
      while (after < text.length && /[\t\n\r ]/.test(text[after]!)) after++;
      if (text[after] === ':') {
        const frame = stack.at(-1);
        if (frame?.kind !== '{') fail('invalid_json');
        let key: string;
        try {
          key = JSON.parse(text.slice(start, i + 1)) as string;
        } catch {
          fail('invalid_json');
        }
        if (frame.keys.has(key)) fail('invalid_json');
        frame.keys.add(key);
      }
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? { kind: c, keys: new Set() } : { kind: c });
      if (stack.length > LIBRARY_ARCHIVE_LIMITS.depth) fail('bounds');
    } else if (c === '}' || c === ']') {
      if (stack.pop()?.kind !== (c === '}' ? '{' : '[')) fail('invalid_json');
    }
  }
  if (stack.length) fail('invalid_json');
}

function parse(bytes: Uint8Array): unknown {
  if (bytes.byteLength > LIBRARY_ARCHIVE_LIMITS.uploadBytes) fail('bounds');
  let text: string;
  try {
    // Invalid UTF-8 must not silently acquire replacement characters in private evidence.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_json');
  }
  inspectJson(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('invalid_json');
  }
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string' && !next.isWellFormed()) fail('invalid_json');
    if (typeof next === 'number' && !Number.isFinite(next)) fail('invalid_json');
    if (next && typeof next === 'object') {
      if (Array.isArray(next)) for (const child of next) pending.push(child);
      else
        for (const [key, child] of Object.entries(next)) {
          if (!key.isWellFormed()) fail('invalid_json');
          pending.push(child);
        }
    }
  }
  return value;
}

function manifestOf(value: unknown): LibraryArchiveManifest {
  if (value === null || value === undefined) fail('incomplete_capture');
  const m = object(value, 'invalid_envelope');
  if (m.format !== LIBRARY_EXPORT_FORMAT || (m.version !== 1 && m.version !== 2)) fail('unsupported_version');
  const version = m.version as LibraryExportVersion;
  const installedSections: readonly string[] = sectionsForVersion(version);
  if (m.rows === undefined || m.recordBytes === undefined || m.sections === undefined) fail('incomplete_capture');
  const required = [
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
    ...(version === 2 ? ['coverage', 'sectionTotals'] : []),
  ];
  if (
    !exactKeys(m, required) ||
    !uuid(m.exportId) ||
    !timestamp(m.capturedAt) ||
    !timestamp(m.expiresAt) ||
    Date.parse(m.expiresAt) - Date.parse(m.capturedAt) !== 15 * 60_000 ||
    m.privacy !== 'private' ||
    m.completeness !== 'supported-native-facts' ||
    m.fullExport !== false ||
    (version === 2 && m.coverage !== 'private-library-owner-facts-v2')
  )
    fail('invalid_envelope');
  const sections = m.sections;
  if (
    !Array.isArray(sections) ||
    sections.length !== installedSections.length ||
    installedSections.some((section, index) => sections[index] !== section)
  )
    fail('incomplete_capture');
  const omissions = object(m.omissions, 'invalid_envelope');
  if (
    !exactKeys(omissions, [
      'trash',
      'providerIdentifiers',
      'personalImportEvidence',
      'commerce',
      'publication',
      'reimport',
    ]) ||
    Object.values(omissions).some((text) => typeof text !== 'string' || text.length === 0)
  )
    fail('invalid_envelope');
  if (
    !Number.isSafeInteger(m.rows) ||
    (m.rows as number) < 0 ||
    !Number.isSafeInteger(m.recordBytes) ||
    (m.recordBytes as number) < 0
  )
    fail('inconsistent_manifest');
  if (
    (m.rows as number) > LIBRARY_EXPORT_LIMITS.records ||
    (m.recordBytes as number) > LIBRARY_EXPORT_LIMITS.recordBytes
  )
    fail('bounds');
  if (version === 2) {
    const totals = object(m.sectionTotals, 'invalid_envelope');
    if (
      !exactKeys(totals, installedSections) ||
      installedSections.some((section) => {
        const value = object(totals[section], 'invalid_envelope');
        return (
          !exactKeys(value, ['rows', 'recordBytes']) ||
          !Number.isSafeInteger(value.rows) ||
          (value.rows as number) < 0 ||
          !Number.isSafeInteger(value.recordBytes) ||
          (value.recordBytes as number) < 0
        );
      }) ||
      installedSections.reduce((sum, section) => sum + Number((totals[section] as ObjectValue).rows), 0) !==
        m.rows ||
      installedSections.reduce(
        (sum, section) => sum + Number((totals[section] as ObjectValue).recordBytes),
        0,
      ) !== m.recordBytes
    )
      fail('inconsistent_manifest');
  }
  // Expiry fences the producer's page stream. An already completed file remains readable after expiry.
  return m as LibraryArchiveManifest;
}

function reference(row: ObjectValue, key: string) {
  const value = row[key],
    ref = row[`${key}_reference`];
  if (value === null) {
    if (ref !== undefined) fail('invalid_record');
    return;
  }
  if (!uuid(value)) fail('invalid_record');
  const r = object(ref, 'invalid_record');
  if (!exactKeys(r, ['id', 'href']) || r.id !== value || r.href !== `https://rezics.com/subjects/${value}`)
    fail('invalid_record');
}

function validJournalDate(value: unknown): boolean {
  if (value === null) return true;
  const date = object(value, 'invalid_record');
  if (
    !exactKeys(date, ['year'], ['month', 'day']) ||
    !Number.isInteger(date.year) ||
    (date.year as number) < 1 ||
    (date.year as number) > 9_999 ||
    (Object.hasOwn(date, 'month') &&
      (!Number.isInteger(date.month) || (date.month as number) < 1 || (date.month as number) > 12)) ||
    (Object.hasOwn(date, 'day') &&
      (!Object.hasOwn(date, 'month') || !Number.isInteger(date.day) || (date.day as number) < 1))
  )
    return false;
  if (!Object.hasOwn(date, 'day')) return true;
  const year = date.year as number;
  const month = date.month as number;
  const day = date.day as number;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

function supportedRecord(row: ObjectValue, section: MergeSection) {
  if (section === 'annotations') {
    if (
      !exactKeys(row, [
        'section',
        'accountId',
        'subjectId',
        'entryIncarnationId',
        'libraryProfilePin',
        'annotationRevision',
        'annotationUpdatedAt',
      ], ['note', 'priority']) ||
      !uuid(row.accountId) ||
      !uuid(row.subjectId) ||
      (row.entryIncarnationId !== null && !uuid(row.entryIncarnationId)) ||
      (row.libraryProfilePin !== null &&
        (!row.libraryProfilePin || typeof row.libraryProfilePin !== 'object' || Array.isArray(row.libraryProfilePin))) ||
      !revision(row.annotationRevision) ||
      (Object.hasOwn(row, 'note') && row.note !== null &&
        (typeof row.note !== 'string' ||
          row.note.length === 0 ||
          row.note.includes('\u0000') ||
          Buffer.byteLength(row.note, 'utf8') > 4_096)) ||
      (Object.hasOwn(row, 'priority') && row.priority !== null &&
        (!Number.isInteger(row.priority) || (row.priority as number) < 1 || (row.priority as number) > 100)) ||
      (row.annotationUpdatedAt !== null && !timestamp(row.annotationUpdatedAt))
    )
      fail('invalid_record');
    return;
  }
  if (section === 'journals') {
    const journal = object(row.journal, 'invalid_record');
    if (
      !exactKeys(row, [
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
      ]) ||
      !exactKeys(journal, ['sessionId', 'revision', 'reflection'], ['startDate', 'finishDate']) ||
      !uuid(row.accountId) ||
      !uuid(row.sessionId) ||
      !uuid(row.subjectId) ||
      (row.versionSubjectId !== null && !uuid(row.versionSubjectId)) ||
      typeof row.state !== 'string' ||
      !revision(row.progressRevision) ||
      (row.libraryProfilePin !== null &&
        (!row.libraryProfilePin || typeof row.libraryProfilePin !== 'object' || Array.isArray(row.libraryProfilePin))) ||
      !timestamp(row.startedAt) ||
      (row.completedAt !== null && !timestamp(row.completedAt)) ||
      (row.lastChangedAt !== null && !timestamp(row.lastChangedAt)) ||
      journal.sessionId !== row.sessionId ||
      !Number.isSafeInteger(journal.revision) ||
      (journal.revision as number) < 0 ||
      (Object.hasOwn(journal, 'startDate') && journal.startDate !== null && !validJournalDate(journal.startDate)) ||
      (Object.hasOwn(journal, 'finishDate') && journal.finishDate !== null && !validJournalDate(journal.finishDate)) ||
      (journal.reflection !== null && typeof journal.reflection !== 'string')
    )
      fail('invalid_record');
    return;
  }
  const common = ['section', 'revision', 'created_at', 'updated_at'];
  const fields =
    section === 'entries'
      ? [
          'subject_id',
          'requested_subject_id',
          'incarnation_id',
          'state',
          'library_profile_pin',
          'activity_at',
          'finished_at',
          'subject_id_reference',
        ]
      : section === 'labels'
        ? ['label_id', 'normalized_name']
        : ['subject_id', 'label_id', 'assignment_id', 'subject_id_reference'];
  if (
    !exactKeys(row, [...common, ...fields], section === 'entries' ? ['requested_subject_id_reference'] : []) ||
    !revision(row.revision) ||
    !timestamp(row.created_at) ||
    !timestamp(row.updated_at)
  )
    fail('invalid_record');
  if (section === 'labels') {
    if (!uuid(row.label_id) || typeof row.normalized_name !== 'string' || !row.normalized_name.length)
      fail('invalid_record');
    return;
  }
  reference(row, 'subject_id');
  if (section === 'assignments') {
    if (!uuid(row.label_id) || (row.assignment_id !== null && !uuid(row.assignment_id))) fail('invalid_record');
    return;
  }
  reference(row, 'requested_subject_id');
  if (
    (row.incarnation_id !== null && !uuid(row.incarnation_id)) ||
    typeof row.state !== 'string' ||
    (row.library_profile_pin !== null &&
      (!row.library_profile_pin ||
        typeof row.library_profile_pin !== 'object' ||
        Array.isArray(row.library_profile_pin))) ||
    (row.activity_at !== null && !timestamp(row.activity_at)) ||
    (row.finished_at !== null && !timestamp(row.finished_at))
  )
    fail('invalid_record');
}

const identityFields: Record<LibraryExportSection, readonly string[]> = {
  entries: ['subject_id'],
  labels: ['label_id'],
  assignments: ['subject_id', 'label_id'],
  sessions: ['session_id'],
  holdings: ['copy_id'],
  collections: ['collection_id'],
  collectionPins: [],
  bangumiUploads: ['upload_id'],
  bangumiEvidence: ['upload_id', 'ordinal'],
  malImports: ['upload_id'],
  units: ['session_id', 'unit_id'],
  history: ['session_id', 'change_no'],
  occurrences: ['member_id'],
  malEvidence: ['upload_id', 'ordinal'],
  annotations: ['subjectId'],
  provenance: ['subjectId'],
  journals: ['sessionId'],
};
function recordKey(row: ObjectValue, section: LibraryExportSection) {
  const values = identityFields[section].map((key) => {
    const value = row[key];
    if (key === 'ordinal' || key === 'change_no') {
      if (!Number.isSafeInteger(value) || (value as number) < (key === 'ordinal' ? 0 : 1)) fail('invalid_record');
    } else if (key === 'unit_id') {
      if (typeof value !== 'string') fail('invalid_record');
    } else if (!uuid(value)) fail('invalid_record');
    return value;
  });
  if (section === 'provenance') {
    const observation = object(row.observation, 'invalid_record');
    if (typeof observation.provider !== 'string' || typeof observation.recordId !== 'string') fail('invalid_record');
    values.push(observation.provider, observation.recordId);
  }
  return JSON.stringify([section, ...values]);
}

/** Decode the producer's completed {manifest,records} file into inert, loss-aware private evidence.
 * All native IDs, revisions, names, state vocabulary and accepting pins remain evidence only.
 */
export function decodeLibraryArchive(bytes: Uint8Array): LibraryArchive {
  const envelope = object(parse(bytes), 'invalid_envelope');
  const manifest = manifestOf(envelope.manifest);
  if (!exactKeys(envelope, ['manifest', 'records'])) fail('invalid_envelope');
  if (!Array.isArray(envelope.records)) fail('invalid_envelope');
  if (envelope.records.length > LIBRARY_ARCHIVE_LIMITS.records) fail('bounds');
  if (envelope.records.length !== manifest.rows) fail('inconsistent_manifest');
  const manifestSections: readonly string[] = sectionsForVersion(manifest.version);
  const counts = new Map<LibraryExportSection, number>(exportSectionsV2.map((s) => [s, 0]));
  const totals = new Map<LibraryExportSection, { rows: number; recordBytes: number }>(
    exportSectionsV2.map((s) => [s, { rows: 0, recordBytes: 0 }]),
  );
  const seen = new Set<string>(),
    labelIds = new Set<string>(),
    names = new Set<string>();
  let recordBytes = 0,
    previousSection = 0;
  for (const value of envelope.records) {
    const row = object(value, 'invalid_record'),
      section = row.section as LibraryExportSection;
    const index = manifestSections.indexOf(section);
    if (index < previousSection || index === -1) fail('invalid_record');
    previousSection = index;
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > LIBRARY_ARCHIVE_LIMITS.pageBytes) fail('bounds');
    recordBytes += size;
    if (recordBytes > LIBRARY_ARCHIVE_LIMITS.recordBytes) fail('bounds');
    if ((archiveMergeSections as readonly string[]).includes(section)) supportedRecord(row, section as MergeSection);
    const key = recordKey(row, section);
    if (seen.has(key)) fail('duplicate_record');
    seen.add(key);
    counts.set(section, counts.get(section)! + 1);
    const sectionTotal = totals.get(section)!;
    sectionTotal.rows++;
    sectionTotal.recordBytes += size;
    if (section === 'labels') {
      if (names.has(row.normalized_name as string)) fail('duplicate_label');
      names.add(row.normalized_name as string);
      labelIds.add(row.label_id as string);
    }
    // The installed export includes only assignments with a live owner label parent.
    if (section === 'assignments' && !labelIds.has(row.label_id as string)) fail('incomplete_capture');
  }
  if (recordBytes !== manifest.recordBytes) fail('inconsistent_manifest');
  if (manifest.version === 2) {
    for (const section of exportSectionsV2) {
      const expected = manifest.sectionTotals[section];
      const actual = totals.get(section)!;
      if (expected.rows !== actual.rows || expected.recordBytes !== actual.recordBytes) fail('inconsistent_manifest');
    }
  }
  return {
    manifest,
    records: envelope.records as ArchiveRecord[],
    fullRestoration: false,
    coverage: exportSectionsV2.map((section) => ({
      section,
      rows: counts.get(section)!,
      capture: counts.get(section) ? 'present' : 'empty',
      treatment:
        manifestSections.includes(section) && (archiveMergeSections as readonly string[]).includes(section)
        ? 'requires-explicit-mapping'
        : 'retained-unsupported',
    })),
  };
}
