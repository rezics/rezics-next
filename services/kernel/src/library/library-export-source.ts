import type { PoolClient } from 'pg';
import {
  exportSections,
  exportSectionsV2,
  LIBRARY_EXPORT_LIMITS,
  sectionsForVersion,
  type LibraryExportSectionV1,
  type LibraryExportSectionV2,
  type LibraryExportVersion,
} from './library-export-format.ts';
export { exportSections, exportSectionsV2 } from './library-export-format.ts';

type JournalDate = { year: number } | { year: number; month: number } | { year: number; month: number; day: number };
type PrivacyFact =
  | { status: 'absent' | 'cleared' }
  | { status: 'unknown'; sourceValue?: string }
  | { status: 'known'; meaning: 'private' | 'source_visible' };
type TimestampFact =
  | { status: 'absent' | 'cleared' }
  | { status: 'unknown'; sourceValue?: string }
  | {
      status: 'known';
      value: string;
      precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
      zone: 'utc' | 'offset' | 'unknown';
    };

type ExistingExportRecord = Record<string, unknown> & { section: LibraryExportSectionV1 };
export type AnnotationExportRecord = {
  section: 'annotations';
  accountId: string;
  subjectId: string;
  entryIncarnationId: string | null;
  libraryProfilePin: unknown | null;
  annotationRevision: number;
  note: string | null;
  priority: number | null;
  annotationUpdatedAt: string | null;
};
export type ProvenanceExportRecord = {
  section: 'provenance';
  accountId: string;
  subjectId: string;
  entryIncarnationId: string | null;
  libraryProfilePin: unknown | null;
  observation: {
    provider: string;
    recordId: string;
    revision: number;
    privacy: PrivacyFact;
    sourceCreated: TimestampFact;
    sourceUpdated: TimestampFact;
    recordedAt: string;
  };
};
export type JournalExportRecord = {
  section: 'journals';
  accountId: string;
  sessionId: string;
  subjectId: string;
  versionSubjectId: string | null;
  state: string;
  progressRevision: number;
  libraryProfilePin: unknown | null;
  startedAt: string;
  completedAt: string | null;
  lastChangedAt: string | null;
  journal: {
    sessionId: string;
    revision: number;
    startDate: JournalDate | null;
    finishDate: JournalDate | null;
    reflection: string | null;
  };
};
export type ExportRecord = ExistingExportRecord | AnnotationExportRecord | ProvenanceExportRecord | JournalExportRecord;
type SourceRow = Record<string, unknown> & { key: string };
export type ExportSeek = {
  section: number;
  parent: string;
  after: string;
  rows: number;
  bytes: number;
  sectionTotals?: [number, number][];
};
const ZERO = '00000000-0000-0000-0000-000000000000';
const FETCH_ROWS = LIBRARY_EXPORT_LIMITS.pageRows + 1;
const v1DirectSections = new Set<string>(exportSections.slice(0, 10));

export const initialExportSeek = (version: LibraryExportVersion = 1): ExportSeek => ({
  section: 0,
  parent: '',
  after: '',
  rows: 0,
  bytes: 0,
  ...(version === 2 ? { sectionTotals: exportSectionsV2.map(() => [0, 0] as [number, number]) } : {}),
});
export type ExportSourcePage = {
  records: ExportRecord[];
  seek: ExportSeek;
  done: boolean;
  oversized: boolean;
};

/** Each indexed selection fetches P+1 bounded rows so a full page can seek without an empty follow-up page. */
const queries: Partial<Record<LibraryExportSectionV2, string>> = {
  entries: `SELECT subject_id::text AS key, subject_id, requested_subject_id, incarnation_id, state,
    revision, library_profile_pin, created_at::text, updated_at::text, activity_at::text, finished_at::text
    FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id > $3::uuid
    ORDER BY subject_id LIMIT ${FETCH_ROWS}`,
  labels: `SELECT label_id::text AS key, label_id, normalized_name, revision, created_at::text, updated_at::text
    FROM library.personal_label WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL AND label_id > $3::uuid
    ORDER BY label_id LIMIT ${FETCH_ROWS}`,
  assignments: `SELECT a.subject_id::text||'/'||a.label_id::text AS key,
    a.subject_id,a.label_id,a.assignment_id,a.revision,a.created_at::text,a.updated_at::text
    FROM library.label_assignment a WHERE a.route=$1 AND a.account_id=$2 AND a.deleted_at IS NULL
      AND (a.subject_id,a.label_id) > (split_part($3,'/',1)::uuid,split_part($3,'/',2)::uuid)
      AND EXISTS (SELECT 1 FROM library.personal_label l WHERE l.route=$1 AND l.account_id=$2
        AND l.label_id=a.label_id AND l.deleted_at IS NULL)
    ORDER BY a.subject_id,a.label_id LIMIT ${FETCH_ROWS}`,
  sessions: `SELECT session_id::text AS key, session_id,subject_id,version_subject_id,mode,unit,total::text,
    amount::text,additional_measures,locator,position::text,completed_unit_count,state,revision,library_profile_pin,
    started_at::text,completed_at::text,last_changed_at::text
    FROM library.progress_session WHERE state <> 'retired' AND route=$1 AND account_id=$2 AND session_id > $3::uuid
    ORDER BY session_id LIMIT ${FETCH_ROWS}`,
  holdings: `SELECT copy_id::text AS key,copy_id,subject_id,kind,status,library_profile_pin,kind_profile_pin,
    status_profile_pin,location,source,acquired_on::text,disposed_on::text,note,revision,created_at::text,updated_at::text
    FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL AND copy_id > $3::uuid
    ORDER BY copy_id LIMIT ${FETCH_ROWS}`,
  collections: `SELECT c.collection_id::text AS key,c.collection_id,c.title,c.description,c.visibility,
    c.revision,c.membership_kind,c.builtin_kind,c.builtin_release_digest,c.builtin_profile_id,c.builtin_state_set_id,
    c.builtin_state_id,c.presentation_kind,c.rule_filter,c.rule_sort,c.rule_release_digest,c.rule_revision::text,
    c.created_at::text,c.updated_at::text
    FROM library.collection c
    WHERE c.route=$1 AND c.curator_account_id=$2 AND c.state='active' AND c.collection_id > $3::uuid
    ORDER BY c.collection_id LIMIT ${FETCH_ROWS}`,
  collectionPins: `SELECT account_id::text AS key,collection_ids,revision::text FROM library.collection_pins
    WHERE route=$1 AND account_id=$2 AND account_id>$3::uuid ORDER BY account_id LIMIT 1`,
  bangumiUploads: `SELECT upload_id::text AS key,upload_id,cancelled FROM library.bangumi_upload
    WHERE route=$1 AND account_id=$2 AND upload_id>$3::uuid ORDER BY upload_id LIMIT ${FETCH_ROWS}`,
  bangumiEvidence: `SELECT upload_id::text||'/'||ordinal::text AS key,upload_id,ordinal,evidence
    FROM library.bangumi_upload_row WHERE route=$1 AND account_id=$2
      AND (upload_id,ordinal)>(split_part($3,'/',1)::uuid,split_part($3,'/',2)::integer)
    ORDER BY upload_id,ordinal LIMIT ${FETCH_ROWS}`,
  malImports: `SELECT id::text AS key,id AS upload_id,(document->>'canceled')::boolean AS cancelled,expires_at::text
    FROM library.list_import_mal WHERE route=$1 AND account_id=$2 AND expires_at>$4::timestamptz
      AND id>$3::uuid ORDER BY id LIMIT ${FETCH_ROWS}`,
  annotations: `SELECT f.subject_id::text AS key,f.account_id::text AS "accountId",f.subject_id::text AS "subjectId",
    f.annotation_revision AS "annotationRevision",f.note,f.priority,
    CASE WHEN f.annotation_updated_at IS NULL THEN NULL ELSE
      to_char(f.annotation_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "annotationUpdatedAt"
    FROM library.entry_personal_fact f
    WHERE f.route=$1 AND f.account_id=$2 AND f.annotation_revision>0 AND f.subject_id>$3::uuid
    ORDER BY f.subject_id LIMIT ${FETCH_ROWS}`,
  provenance: `SELECT jsonb_build_array(o.subject_id::text,o.provider,o.record_id)::text AS key,
    o.account_id::text AS "accountId",o.subject_id::text AS "subjectId",
    jsonb_build_object('provider',o.provider,'recordId',o.record_id,'revision',o.revision,
      'privacy',CASE o.privacy_status
        WHEN 'known' THEN jsonb_build_object('status','known','meaning',o.privacy_meaning)
        WHEN 'unknown' THEN jsonb_strip_nulls(jsonb_build_object('status','unknown','sourceValue',o.privacy_source_value))
        WHEN 'cleared' THEN jsonb_build_object('status','cleared')
        ELSE jsonb_build_object('status','absent') END,
      'sourceCreated',CASE o.source_created_status
        WHEN 'known' THEN jsonb_build_object('status','known','value',o.source_created_value,
          'precision',o.source_created_precision,'zone',o.source_created_zone)
        WHEN 'unknown' THEN jsonb_strip_nulls(jsonb_build_object('status','unknown','sourceValue',o.source_created_value))
        WHEN 'cleared' THEN jsonb_build_object('status','cleared')
        ELSE jsonb_build_object('status','absent') END,
      'sourceUpdated',CASE o.source_updated_status
        WHEN 'known' THEN jsonb_build_object('status','known','value',o.source_updated_value,
          'precision',o.source_updated_precision,'zone',o.source_updated_zone)
        WHEN 'unknown' THEN jsonb_strip_nulls(jsonb_build_object('status','unknown','sourceValue',o.source_updated_value))
        WHEN 'cleared' THEN jsonb_build_object('status','cleared')
        ELSE jsonb_build_object('status','absent') END,
      'recordedAt',to_char(o.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS observation
    FROM library.entry_source_observation o
    WHERE o.route=$1 AND o.account_id=$2
      AND (o.subject_id,o.provider,o.record_id)>((($3::jsonb)->>0)::uuid,($3::jsonb)->>1,($3::jsonb)->>2)
    ORDER BY o.subject_id,o.provider,o.record_id LIMIT ${FETCH_ROWS}`,
  journals: `SELECT p.session_id::text AS key,p.account_id::text AS "accountId",p.session_id::text AS "sessionId",
    p.subject_id::text AS "subjectId",p.version_subject_id::text AS "versionSubjectId",p.state,
    p.revision AS "progressRevision",p.library_profile_pin AS "libraryProfilePin",
    p.started_at::text AS "startedAt",p.completed_at::text AS "completedAt",p.last_changed_at::text AS "lastChangedAt",
    jsonb_build_object('sessionId',p.session_id::text,'revision',p.journal_revision,
      'startDate',CASE WHEN p.journal_start_year IS NULL THEN NULL ELSE
        jsonb_strip_nulls(jsonb_build_object('year',p.journal_start_year,'month',p.journal_start_month,'day',p.journal_start_day)) END,
      'finishDate',CASE WHEN p.journal_finish_year IS NULL THEN NULL ELSE
        jsonb_strip_nulls(jsonb_build_object('year',p.journal_finish_year,'month',p.journal_finish_month,'day',p.journal_finish_day)) END,
      'reflection',p.journal_reflection) AS journal
    FROM library.progress_session p
    WHERE p.route=$1 AND p.account_id=$2 AND p.state<>'retired' AND p.journal_revision>0 AND p.session_id>$3::uuid
    ORDER BY p.session_id LIMIT ${FETCH_ROWS}`,
};

/** The database refuses a single unbounded row before it reaches the driver buffer. */
async function bounded(client: Pick<PoolClient, 'query'>, sql: string, args: unknown[], maxRecordBytes: number) {
  return (
    await client.query<{ value: SourceRow | null }>(
      `WITH page AS MATERIALIZED (${sql}) SELECT CASE WHEN octet_length(to_jsonb(page)::text)<=$${args.length + 1}
      THEN to_jsonb(page) ELSE NULL END AS value FROM page`,
      [...args, maxRecordBytes],
    )
  ).rows;
}

function v1Direct(section: LibraryExportSectionV2, version: LibraryExportVersion) {
  return version === 1 ? v1DirectSections.has(section) : Object.hasOwn(queries, section);
}

export async function readExportSourcePage(
  client: Pick<PoolClient, 'query'>,
  route: number,
  accountId: string,
  input: ExportSeek,
  capturedAt: string,
  version: LibraryExportVersion = 1,
): Promise<ExportSourcePage> {
  const seek = {
    ...input,
    sectionTotals: input.sectionTotals?.map(([rows, bytes]) => [rows, bytes] as [number, number]),
  };
  const sections = sectionsForVersion(version);
  const section = sections[seek.section] as LibraryExportSectionV2 | undefined;
  if (!section) throw new TypeError('Invalid library export section cursor');
  const fetchRows = version === 1 ? LIBRARY_EXPORT_LIMITS.pageRows : FETCH_ROWS;

  let rows: { value: SourceRow | null }[];
  if (v1Direct(section, version)) {
    const sourceSql = queries[section];
    if (!sourceSql) throw new TypeError('Unsupported library export section');
    const sql = version === 1 ? sourceSql.replaceAll(`LIMIT ${FETCH_ROWS}`, `LIMIT ${fetchRows}`) : sourceSql;
    const after =
      seek.after ||
      (section === 'assignments'
        ? `${ZERO}/${ZERO}`
        : section === 'bangumiEvidence'
          ? `${ZERO}/-1`
          : section === 'provenance'
            ? JSON.stringify([ZERO, '', ''])
            : ZERO);
    rows = await bounded(
      client,
      sql,
      section === 'malImports' ? [route, accountId, after, capturedAt] : [route, accountId, after],
      LIBRARY_EXPORT_LIMITS.maxRecordBytes,
    );
  } else {
    const occurrences = section === 'occurrences';
    const mal = section === 'malEvidence';
    if (!seek.parent) {
      const parentSql = mal
        ? `SELECT id FROM library.list_import_mal WHERE route=$1 AND account_id=$2
             AND expires_at>$4::timestamptz AND id>$3::uuid ORDER BY id LIMIT 1`
        : occurrences
          ? `SELECT collection_id AS id FROM library.collection WHERE route=$1 AND curator_account_id=$2
             AND state='active' AND membership_kind='curated' AND collection_id>$3::uuid ORDER BY collection_id LIMIT 1`
          : `SELECT session_id AS id FROM library.progress_session WHERE state <> 'retired' AND route=$1 AND account_id=$2
             AND session_id>$3::uuid ORDER BY session_id LIMIT 1`;
      seek.parent =
        (
          await client.query<{ id: string }>(
            parentSql,
            mal ? [route, accountId, seek.after || ZERO, capturedAt] : [route, accountId, seek.after || ZERO],
          )
        ).rows[0]?.id ?? '';
      seek.after = '';
      if (!seek.parent) {
        seek.section++;
        return { records: [], seek, done: seek.section === sections.length, oversized: false };
      }
    }
    const sql = mal
      ? `SELECT i::text AS key,id AS upload_id,i AS ordinal,document->'rows'->i AS evidence
           FROM library.list_import_mal CROSS JOIN LATERAL generate_series($3::integer+1,
             least(jsonb_array_length(document->'rows')-1,$3::integer+${fetchRows})) i
           WHERE route=$1 AND id=$2 AND account_id=$4 ORDER BY i LIMIT ${fetchRows}`
      : section === 'units'
        ? `SELECT unit_id AS key,session_id,unit_id,added_at::text FROM library.progress_unit
           WHERE route=$1 AND session_id=$2 AND EXISTS (SELECT 1 FROM library.progress_session p WHERE p.route=$1 AND p.account_id=$4
             AND p.session_id=$2 AND p.state <> 'retired') AND unit_id COLLATE "C">$3 COLLATE "C" ORDER BY unit_id COLLATE "C" LIMIT ${fetchRows}`
        : section === 'history'
          ? `SELECT change_no::text AS key,session_id,change_no,intent,recorded_at::text FROM library.progress_change
             WHERE route=$1 AND session_id=$2 AND EXISTS (SELECT 1 FROM library.progress_session p WHERE p.route=$1 AND p.account_id=$4
               AND p.session_id=$2 AND p.state <> 'retired') AND change_no>$3::integer ORDER BY change_no LIMIT ${fetchRows}`
          : `SELECT member_id::text AS key,member_id,collection_id,subject_id,note,ordinal_key,member_revision::text,added_at::text
             FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL
             AND member_id>$3::uuid ORDER BY member_id LIMIT ${fetchRows}`;
    rows = await bounded(
      client,
      sql,
      [
        route,
        seek.parent,
        seek.after || (mal ? '-1' : section === 'history' ? '0' : occurrences ? ZERO : ''),
        ...(mal || section === 'units' || section === 'history' ? [accountId] : []),
      ],
      LIBRARY_EXPORT_LIMITS.maxRecordBytes,
    );
  }

  const entryFacts = new Map<string, { entryIncarnationId: string | null; libraryProfilePin: unknown | null }>();
  if (section === 'annotations' || section === 'provenance') {
    const selected = rows.slice(0, LIBRARY_EXPORT_LIMITS.pageRows);
    if (selected.some((row) => !row.value)) return { records: [], seek, done: false, oversized: true };
    const subjectIds = [...new Set(selected.map((row) => String(row.value!.subjectId)))];
    if (subjectIds.length) {
      const joined = await bounded(
        client,
        `SELECT e.subject_id::text AS key,e.incarnation_id::text AS "entryIncarnationId",
          e.library_profile_pin AS "libraryProfilePin"
         FROM library.entry e WHERE e.route=$1 AND e.account_id=$2 AND e.subject_id=ANY($3::uuid[])
         ORDER BY e.subject_id LIMIT ${LIBRARY_EXPORT_LIMITS.pageRows}`,
        [route, accountId, subjectIds],
        LIBRARY_EXPORT_LIMITS.maxRecordBytes,
      );
      if (joined.some((row) => !row.value)) return { records: [], seek, done: false, oversized: true };
      for (const row of joined) {
        const entry = row.value!;
        entryFacts.set(String(entry.key), {
          entryIncarnationId: entry.entryIncarnationId as string | null,
          libraryProfilePin: entry.libraryProfilePin,
        });
      }
    }
  }

  const records: ExportRecord[] = [];
  let oversized = false;
  let pageBytes = 0;
  for (const row of rows) {
    if (records.length === LIBRARY_EXPORT_LIMITS.pageRows) break;
    if (!row.value) {
      oversized = true;
      break;
    }
    const { key, ...data } = row.value;
    if (section === 'annotations' || section === 'provenance') {
      const entry = entryFacts.get(String(data.subjectId));
      data.entryIncarnationId = entry?.entryIncarnationId ?? null;
      data.libraryProfilePin = entry?.libraryProfilePin ?? null;
    }
    if (section === 'malEvidence') data.evidence = publicEvidence(data.evidence);
    if (section !== 'annotations' && section !== 'provenance' && section !== 'journals') {
      for (const field of ['subject_id', 'requested_subject_id', 'version_subject_id']) {
        const value = data[field];
        if (typeof value === 'string')
          data[`${field}_reference`] = {
            id: value,
            href: `https://rezics.com/subjects/${value}`,
          };
      }
    }
    const record = { section, ...data } as ExportRecord;
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (version === 2 && bytes > LIBRARY_EXPORT_LIMITS.maxRecordBytes) {
      oversized = true;
      break;
    }
    if (pageBytes + bytes > LIBRARY_EXPORT_LIMITS.pageBytes) {
      if (!records.length) oversized = true;
      break;
    }
    records.push(record);
    pageBytes += bytes;
    seek.after = String(key);
    if (seek.sectionTotals) {
      const [totalRows, totalBytes] = seek.sectionTotals[seek.section]!;
      seek.sectionTotals[seek.section] = [totalRows + 1, totalBytes + bytes];
    }
  }
  if (records.length === rows.length && rows.length < fetchRows) {
    if (v1Direct(section, version)) {
      seek.section++;
      seek.after = '';
    } else {
      seek.after = seek.parent;
      seek.parent = '';
    }
  }
  seek.rows += records.length;
  seek.bytes += pageBytes;
  return { records, seek, done: seek.section === sections.length, oversized };
}

/** Retained import rows exclude raw credentials and review capabilities before export. */
function publicEvidence(value: unknown): unknown {
  const privateKey = /token|password|authorization|credential|secret|capability/i;
  if (Array.isArray(value))
    return value
      .filter((v) => !(v && typeof v === 'object' && 'field' in v && privateKey.test(String(v.field))))
      .map(publicEvidence);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateKey.test(key))
        .map(([key, v]) => [key, publicEvidence(v)]),
    );
  return value;
}
