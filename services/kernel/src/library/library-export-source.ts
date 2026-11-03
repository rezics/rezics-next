import type { PoolClient } from 'pg';

/** Fixed owner projections. No transaction, custody, output or capability columns enter this format. */
const queries = {
  entries: `SELECT subject_id::text AS key, subject_id, requested_subject_id, incarnation_id, state,
    revision, library_profile_pin, created_at::text, updated_at::text, activity_at::text, finished_at::text
    FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id > $3::uuid
    ORDER BY subject_id LIMIT 16`,
  labels: `SELECT label_id::text AS key, label_id, normalized_name, revision, created_at::text, updated_at::text
    FROM library.personal_label WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL AND label_id > $3::uuid
    ORDER BY label_id LIMIT 16`,
  assignments: `SELECT a.subject_id::text||'/'||a.label_id::text AS key,
    a.subject_id,a.label_id,a.assignment_id,a.revision,a.created_at::text,a.updated_at::text
    FROM library.label_assignment a WHERE a.route=$1 AND a.account_id=$2 AND a.deleted_at IS NULL
      AND (a.subject_id,a.label_id) > (split_part($3,'/',1)::uuid,split_part($3,'/',2)::uuid)
      AND EXISTS (SELECT 1 FROM library.personal_label l WHERE l.route=$1 AND l.account_id=$2
        AND l.label_id=a.label_id AND l.deleted_at IS NULL)
    ORDER BY a.subject_id,a.label_id LIMIT 16`,
  sessions: `SELECT session_id::text AS key, session_id,subject_id,version_subject_id,mode,unit,total::text,
    amount::text,locator,position::text,completed_unit_count,state,revision,library_profile_pin,
    started_at::text,completed_at::text,last_changed_at::text
    FROM library.progress_session WHERE route=$1 AND account_id=$2 AND session_id > $3::uuid
    ORDER BY session_id LIMIT 16`,
  holdings: `SELECT copy_id::text AS key,copy_id,subject_id,kind,status,library_profile_pin,kind_profile_pin,
    status_profile_pin,location,source,acquired_on::text,disposed_on::text,note,revision,created_at::text,updated_at::text
    FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL AND copy_id > $3::uuid
    ORDER BY copy_id LIMIT 16`,
  collections: `SELECT c.collection_id::text AS key,c.collection_id,c.title,c.description,c.visibility,
    c.revision,c.membership_kind,c.builtin_kind,c.builtin_release_digest,c.builtin_profile_id,c.builtin_state_set_id,
    c.builtin_state_id,c.presentation_kind,c.rule_filter,c.rule_sort,c.rule_release_digest,c.rule_revision::text,
    c.created_at::text,c.updated_at::text
    FROM library.collection c
    WHERE c.route=$1 AND c.curator_account_id=$2 AND c.state='active' AND c.collection_id > $3::uuid
    ORDER BY c.collection_id LIMIT 16`,
  collectionPins: `SELECT account_id::text AS key,collection_ids,revision::text FROM library.collection_pins
    WHERE route=$1 AND account_id=$2 AND account_id>$3::uuid ORDER BY account_id LIMIT 1`,
} as const;
export const exportSections = [...Object.keys(queries), 'units', 'history', 'occurrences'] as const;
export type ExportRecord = Record<string, unknown>;
export type ExportSeek = {
  section: number;
  parent: string;
  after: string;
  rows: number;
  bytes: number;
};
const ZERO = '00000000-0000-0000-0000-000000000000';
export const initialExportSeek = (): ExportSeek => ({
  section: 0,
  parent: '',
  after: '',
  rows: 0,
  bytes: 0,
});
export type ExportSourcePage = {
  records: ExportRecord[];
  seek: ExportSeek;
  done: boolean;
  oversized: boolean;
};

/** A materialized row count and SQL-side encoded-size guard bound both wire bytes and JS memory. */
async function bounded(client: Pick<PoolClient, 'query'>, sql: string, args: unknown[]) {
  return (
    await client.query<{ value: ExportRecord | null }>(
      `WITH page AS MATERIALIZED (${sql}) SELECT CASE WHEN octet_length(to_jsonb(page)::text)<=65536
      THEN to_jsonb(page) ELSE NULL END AS value FROM page`,
      args,
    )
  ).rows;
}

export async function readExportSourcePage(
  client: Pick<PoolClient, 'query'>,
  route: number,
  accountId: string,
  input: ExportSeek,
): Promise<ExportSourcePage> {
  const seek = { ...input };
  const section = exportSections[seek.section]!;
  let rows: Awaited<ReturnType<typeof bounded>>;
  if (seek.section < Object.keys(queries).length) {
    const sql = queries[section as keyof typeof queries];
    const after = seek.after || (section === 'assignments' ? `${ZERO}/${ZERO}` : ZERO);
    rows = await bounded(client, sql, [route, accountId, after]);
  } else {
    const occurrences = section === 'occurrences';
    if (!seek.parent) {
      const sql = occurrences
        ? `SELECT collection_id AS id FROM library.collection WHERE route=$1 AND curator_account_id=$2
             AND state='active' AND membership_kind='curated' AND collection_id>$3::uuid ORDER BY collection_id LIMIT 1`
        : `SELECT session_id AS id FROM library.progress_session WHERE route=$1 AND account_id=$2
             AND session_id>$3::uuid ORDER BY session_id LIMIT 1`;
      seek.parent = (await client.query<{ id: string }>(sql, [route, accountId, seek.after || ZERO])).rows[0]?.id ?? '';
      seek.after = '';
      if (!seek.parent) {
        seek.section++;
        return {
          records: [],
          seek,
          done: seek.section === exportSections.length,
          oversized: false,
        };
      }
    }
    const sql =
      section === 'units'
        ? `SELECT unit_id AS key,session_id,unit_id,added_at::text FROM library.progress_unit
           WHERE route=$1 AND session_id=$2 AND unit_id COLLATE "C">$3 COLLATE "C" ORDER BY unit_id COLLATE "C" LIMIT 16`
        : section === 'history'
          ? `SELECT change_no::text AS key,session_id,change_no,intent,recorded_at::text FROM library.progress_change
             WHERE route=$1 AND session_id=$2 AND change_no>$3::integer ORDER BY change_no LIMIT 16`
          : `SELECT member_id::text AS key,member_id,collection_id,subject_id,note,ordinal_key,member_revision::text,added_at::text
             FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL
             AND member_id>$3::uuid ORDER BY member_id LIMIT 16`;
    // The exact parent was selected on this owner's index in this fenced transaction or a sealed cursor.
    rows = await bounded(client, sql, [
      route,
      seek.parent,
      seek.after || (section === 'history' ? '0' : occurrences ? ZERO : ''),
    ]);
  }
  const records: ExportRecord[] = [];
  let oversized = false;
  let pageBytes = 0;
  for (const row of rows) {
    if (!row.value) {
      oversized = true;
      break;
    }
    const { key, ...data } = row.value;
    for (const field of ['subject_id', 'requested_subject_id', 'version_subject_id']) {
      const value = data[field];
      if (typeof value === 'string')
        data[`${field}_reference`] = {
          id: value,
          href: `https://rezics.com/subjects/${value}`,
        };
    }
    const record = { section, ...data };
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (pageBytes + bytes > 120_000 && records.length) break;
    if (bytes > 120_000) {
      oversized = true;
      break;
    }
    records.push(record);
    pageBytes += bytes;
    seek.after = String(key);
  }
  if (records.length === rows.length && rows.length < 16) {
    if (seek.section < Object.keys(queries).length) {
      seek.section++;
      seek.after = '';
    } else {
      seek.after = seek.parent;
      seek.parent = '';
    }
  }
  seek.rows += records.length;
  seek.bytes += pageBytes;
  return {
    records,
    seek,
    done: seek.section === exportSections.length,
    oversized,
  };
}
