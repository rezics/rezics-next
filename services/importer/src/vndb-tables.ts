import { Database } from 'bun:sqlite';
import { DumpInputError } from './dump-input.ts';
import { createDumpCounters, DEFAULT_DUMP_CHUNK_BYTES, dumpChunkLimit, DumpMemory } from './dumps-bytes.ts';
import {
  VNDB_ACQUISITION_CHECKPOINT_VERSION,
  VndbAcquisitionError,
  admitVndbAcquisitionCheckpoint,
  admitVndbAcquisitionIdentity,
  memberPathDigest,
  type VndbAcquisitionCheckpoint,
  type VndbAcquisitionIdentity,
  type VndbAcquisitionPhase,
} from './vndb-acquisition.ts';

// Decompressed native entry content only; the reader's tar framing cap is independent.
export const DEFAULT_VNDB_ARCHIVE_BYTES = 16 * 1024 ** 3;
export const MAX_VNDB_ARCHIVE_BYTES = 64 * 1024 ** 3;
export const DEFAULT_VNDB_ARCHIVE_ENTRIES = 512;
export const MAX_VNDB_ARCHIVE_ENTRIES = 2048;

/** Raw importer archive input, after tar/zstd framing has been checked by its reader. */
interface ArchiveEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  declaredBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  linkTarget?: string;
}

type Table = 'vn' | 'vn_titles' | 'entry_meta';
type State = 'new' | 'staging' | 'ready' | 'failed';
type Title = { id: string; lang: string; official: boolean; title: string; latin: string | null };
type Metadata = {
  id: string;
  created: string;
  lastmod: string;
  revision: number;
  num_edits: number;
  num_users: number;
};
type GroupedRecord = {
  vn: { id: string; olang: string; c_votecount: number; c_average: number | null; alias: string | null };
  vn_titles: Title[];
  entry_meta: Metadata;
};
type Stored = { id: string; child: string };
type Run = { state: State; sourceRecords: number; stagedRows: number; stagedBytes: number };
type Options = {
  childRowsPerVn?: number;
  pageSize?: number;
  maxRows?: number;
  maxSourceRecords?: number;
  maxChunkBytes?: number;
  maxArchiveBytes?: number;
  maxArchiveEntries?: number;
  observer?: { onBufferedRows?(rows: number): void; onRowWrite?(): void; onBeforeCheckpoint?(): void };
};

export type VndbStageTracking = {
  identity: VndbAcquisitionIdentity;
  resume?: boolean;
  onCommitted?(rows: number): void;
  onVerified?(rows: number): void;
};

type CheckpointRow = {
  version: number;
  sha256: string;
  bytes: number;
  archive_format: string;
  codec: string;
  source_alias: string;
  source_kind: string;
  converter_revision: string;
  projection: string;
  child_cap: number;
  max_rows: number;
  max_source_records: number;
  max_archive_bytes: number;
  max_archive_entries: number;
  decode_budget: number;
  last_complete_ordinal: number;
  current_ordinal: number;
  current_lines: number;
  current_role: string;
  spool_table: string;
  spool_after: number;
  phase: string;
  headers_json: string;
  archive_complete: number;
};

type MemberRow = {
  ordinal: number;
  path_digest: string;
  declared_bytes: number;
  kind: string;
  role: string;
  lines: number;
  complete: number;
};

type Cursor = {
  identity: VndbAcquisitionIdentity;
  lastCompleteOrdinal: number;
  currentOrdinal: number;
  currentLines: number;
  currentRole: string;
  spoolTable: string;
  spoolAfter: number;
  phase: VndbAcquisitionPhase;
  headers: Map<Table, string[]>;
  archiveComplete: boolean;
};

function emptyCheckpoint(identity: VndbAcquisitionIdentity): Cursor {
  return {
    identity,
    lastCompleteOrdinal: 0,
    currentOrdinal: 0,
    currentLines: 0,
    currentRole: '',
    spoolTable: '',
    spoolAfter: 0,
    phase: 'loading',
    headers: new Map(),
    archiveComplete: false,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

function interrupted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

// COPY TO STDOUT, not executable SQL. Official generator/dump evidence and hashes:
// specs/imports-vndb-tables-driver.ts. Only identity, original language, titles
// and native revision are required by the grouped input; vn.alias is carried forward.
// Other VN columns are validated and discarded, including Bayesian ratings,
// description and image identifiers.
// The licensed average and count are retained only for a separate source statistic.
const COLUMNS: Record<Table, readonly string[]> = {
  vn: [
    'id',
    'image',
    'c_image',
    'olang',
    'c_votecount',
    'c_rating',
    'c_average',
    'c_length',
    'c_lengthnum',
    'length',
    'devstatus',
    'alias',
    'description',
  ],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  entry_meta: ['id', 'created', 'lastmod', 'revision', 'num_edits', 'num_users'],
};
const TABLES = Object.keys(COLUMNS) as Table[];
const ROW_BYTES = 64 * 1024;
const BATCH = 32;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid VNDB table input');
}
function bounded(value: number, maximum: number): number {
  check(Number.isSafeInteger(value) && value >= 1 && value <= maximum);
  return value;
}
function identity(source: string, run: string) {
  check(typeof source === 'string' && source.trim() === source && /^[a-z][a-z0-9_-]{0,63}$/.test(source));
  check(typeof run === 'string' && run.trim() === run && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(run));
}
function integer(value: string | null | undefined, max: number, min = 0): number {
  check(typeof value === 'string' && value.trim() === value && /^(?:0|[1-9][0-9]*)$/.test(value));
  const number = Number(value);
  check(Number.isSafeInteger(number) && number >= min && number <= max);
  return number;
}
function nativeId(value: string | null | undefined, onlyVn = true): string {
  check(typeof value === 'string' && /^[a-z][1-9][0-9]{0,9}$/.test(value));
  check(!onlyVn || value[0] === 'v');
  integer(value.slice(1), 2147483647, 1);
  return value;
}
function language(value: string | null | undefined): string {
  check(typeof value === 'string' && value.trim() === value && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value));
  return value;
}
function required(value: string | null | undefined): string {
  check(typeof value === 'string');
  return value;
}
function timestamp(value: string | null | undefined): string {
  const text = required(value);
  check(text.trim() === text);
  check(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/.test(text));
  const date = text.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date);
  if (text.length > 10) {
    check(Number(text.slice(11, 13)) <= 23 && Number(text.slice(14, 16)) <= 59 && Number(text.slice(17, 19)) <= 59);
  }
  return text;
}

/** Decode COPY escapes as bytes first: octal/hex may themselves encode UTF8. */
function cell(bytes: Uint8Array): string | null {
  if (bytes.length === 2 && bytes[0] === 92 && bytes[1] === 78) return null;
  const decoded = new Uint8Array(bytes.length);
  let used = 0;
  for (let i = 0; i < bytes.length; i++) {
    let byte = bytes[i]!;
    if (byte === 92) {
      check(++i < bytes.length);
      const escape = bytes[i]!;
      const controls: Record<number, number> = { 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92 };
      if (Object.hasOwn(controls, escape)) byte = controls[escape]!;
      else if (escape >= 48 && escape <= 55) {
        byte = escape - 48;
        for (let count = 1; count < 3 && i + 1 < bytes.length; count++) {
          const next = bytes[i + 1]!;
          if (next < 48 || next > 55) break;
          byte = byte * 8 + next - 48;
          i++;
        }
        check(byte <= 255);
      } else if (escape === 120) {
        byte = 0;
        let count = 0;
        while (count < 2 && i + 1 < bytes.length) {
          const next = String.fromCharCode(bytes[i + 1]!);
          if (!/^[0-9a-fA-F]$/.test(next)) break;
          byte = byte * 16 + Number.parseInt(next, 16);
          count++;
          i++;
        }
        check(count > 0);
      } else check(false);
    } else check(byte >= 32 && byte !== 127);
    check(byte !== 0);
    decoded[used++] = byte;
  }
  return utf8.decode(decoded.subarray(0, used));
}
function columns(raw: Uint8Array): Array<string | null> {
  const result: Array<string | null> = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === 9) {
      result.push(cell(raw.subarray(start, i)));
      start = i + 1;
    }
  }
  return result;
}

export class VndbTablesStore {
  private bufferedRows = 0;

  private observeRows(rows: number) {
    this.options.observer?.onBufferedRows?.(this.bufferedRows + rows);
  }

  private withRows<T>(rows: number, operation: () => T): T {
    this.bufferedRows += rows;
    this.observeRows(0);
    try {
      return operation();
    } finally {
      this.bufferedRows -= rows;
    }
  }

  private readonly children: number;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly maxSourceRecords: number;
  private readonly chunkBytes: number;
  private readonly archiveBytes: number;
  private readonly archiveEntries: number;

  /** Caller owns the real handle and may attach SQL evidence before construction. */
  constructor(
    private readonly db: Database,
    private readonly options: Options = {},
  ) {
    check(db instanceof Database);
    this.archiveBytes = bounded(
      options.maxArchiveBytes === undefined ? DEFAULT_VNDB_ARCHIVE_BYTES : options.maxArchiveBytes,
      MAX_VNDB_ARCHIVE_BYTES,
    );
    this.archiveEntries = bounded(
      options.maxArchiveEntries === undefined ? DEFAULT_VNDB_ARCHIVE_ENTRIES : options.maxArchiveEntries,
      MAX_VNDB_ARCHIVE_ENTRIES,
    );
    this.children = bounded(options.childRowsPerVn ?? 64, 64);
    this.pageSize = bounded(options.pageSize ?? 16, 16);
    this.maxRows = bounded(options.maxRows ?? 2_000_000, 10_000_000);
    this.maxSourceRecords = bounded(options.maxSourceRecords ?? 500_000, 1_000_000);
    this.chunkBytes = bounded(dumpChunkLimit(options.maxChunkBytes), DEFAULT_DUMP_CHUNK_BYTES);
    // Match importer staging's WAL policy: each completed statement is durable
    // across reopen, without a filesystem synchronization for every COPY row.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vndb_table_runs (
        source TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL,
        source_records INTEGER NOT NULL DEFAULT 0, staged_rows INTEGER NOT NULL DEFAULT 0,
        staged_bytes INTEGER NOT NULL DEFAULT 0, child_cap INTEGER NOT NULL,
        PRIMARY KEY (source, run_id)
      );
      CREATE TABLE IF NOT EXISTS vndb_table_rows (
        source TEXT NOT NULL, run_id TEXT NOT NULL, table_name TEXT NOT NULL,
        id TEXT NOT NULL, id_number INTEGER NOT NULL, child TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (source, run_id, table_name, id, child)
      );
      CREATE INDEX IF NOT EXISTS vndb_table_ids
        ON vndb_table_rows (source, run_id, table_name, id_number, child);
      CREATE TABLE IF NOT EXISTS vndb_table_spool (
        source TEXT NOT NULL, run_id TEXT NOT NULL, table_name TEXT NOT NULL,
        sequence INTEGER NOT NULL, raw BLOB NOT NULL,
        PRIMARY KEY (source, run_id, table_name, sequence)
      );
      CREATE TABLE IF NOT EXISTS vndb_acquisition_checkpoints (
        source TEXT NOT NULL, run_id TEXT NOT NULL, version INTEGER NOT NULL,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, archive_format TEXT NOT NULL,
        codec TEXT NOT NULL, source_alias TEXT NOT NULL, source_kind TEXT NOT NULL,
        converter_revision TEXT NOT NULL, projection TEXT NOT NULL,
        child_cap INTEGER NOT NULL, max_rows INTEGER NOT NULL,
        max_source_records INTEGER NOT NULL, max_archive_bytes INTEGER NOT NULL,
        max_archive_entries INTEGER NOT NULL, decode_budget INTEGER NOT NULL,
        last_complete_ordinal INTEGER NOT NULL, current_ordinal INTEGER NOT NULL,
        current_lines INTEGER NOT NULL, current_role TEXT NOT NULL,
        spool_table TEXT NOT NULL, spool_after INTEGER NOT NULL,
        phase TEXT NOT NULL, headers_json TEXT NOT NULL, archive_complete INTEGER NOT NULL,
        PRIMARY KEY (source, run_id)
      );
      CREATE TABLE IF NOT EXISTS vndb_acquisition_members (
        source TEXT NOT NULL, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        path_digest TEXT NOT NULL, declared_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL, role TEXT NOT NULL, lines INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY (source, run_id, ordinal)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vndb_acquisition_member_roles
        ON vndb_acquisition_members (source, run_id, role) WHERE role <> 'ignored';
    `);
  }

  beginCheckpointed(source: string, runId: string, capture: VndbAcquisitionIdentity): void {
    const identity = admitVndbAcquisitionIdentity(capture);
    this.db.transaction(() => {
      this.begin(source, runId);
      this.writeCheckpoint(source, runId, identity, emptyCheckpoint(identity));
    })();
  }

  checkpoint(source: string, runId: string): VndbAcquisitionCheckpoint | null {
    identity(source, runId);
    const row = this.db
      .query(
        `SELECT version,sha256,bytes,archive_format,codec,source_alias,source_kind,converter_revision,
        projection,child_cap,max_rows,max_source_records,max_archive_bytes,max_archive_entries,
        decode_budget,last_complete_ordinal,current_ordinal,current_lines,current_role,spool_table,
        spool_after,phase,headers_json,archive_complete
        FROM vndb_acquisition_checkpoints WHERE source=? AND run_id=?`,
      )
      .get(source, runId) as CheckpointRow | null;
    if (!row) return null;
    return admitVndbAcquisitionCheckpoint({
      version: row.version,
      identity: {
        sha256: row.sha256,
        bytes: row.bytes,
        archiveFormat: row.archive_format as VndbAcquisitionIdentity['archiveFormat'],
        codec: row.codec as VndbAcquisitionIdentity['codec'],
        sourceAlias: row.source_alias,
        sourceKind: 'vndb',
        converterRevision: row.converter_revision,
        projection: row.projection as VndbAcquisitionIdentity['projection'],
        checkpointVersion: row.version,
        childCap: row.child_cap,
        maxRows: row.max_rows,
        maxSourceRecords: row.max_source_records,
        maxArchiveBytes: row.max_archive_bytes,
        maxArchiveEntries: row.max_archive_entries,
        decodeBudget: row.decode_budget,
      },
      lastCompleteOrdinal: row.last_complete_ordinal,
      currentOrdinal: row.current_ordinal,
      currentLines: row.current_lines,
      currentRole: row.current_role,
      spoolTable: row.spool_table,
      spoolAfter: row.spool_after,
      phase: row.phase,
      headers: row.headers_json,
      archiveComplete: row.archive_complete,
    });
  }

  begin(source: string, runId: string): void {
    identity(source, runId);
    this.db
      .query(`INSERT INTO vndb_table_runs (source,run_id,state,child_cap) VALUES (?,?,'new',?)`)
      .run(source, runId, this.children);
  }

  inspect(source: string, runId: string): Run {
    identity(source, runId);
    const run = this.db
      .query(`SELECT state, source_records AS sourceRecords,
      staged_rows AS stagedRows, staged_bytes AS stagedBytes
      FROM vndb_table_runs WHERE source=? AND run_id=?`)
      .get(source, runId) as Run | null;
    check(run);
    return run;
  }

  async stage(
    source: string,
    runId: string,
    entries: AsyncIterable<ArchiveEntry>,
    tracking?: VndbStageTracking,
  ): Promise<void> {
    identity(source, runId);
    if (tracking) {
      await this.stageTracked(source, runId, entries, tracking);
      return;
    }
    // A repeated/concurrent call cannot invalidate an already ready or active run.
    const started = this.db
      .query(`UPDATE vndb_table_runs SET state='staging'
      WHERE source=? AND run_id=? AND state='new' AND child_cap=?`)
      .run(source, runId, this.children);
    check(started.changes === 1);
    const seen = new Set<string>();
    const headers = new Map<Table, string[]>();
    let inputRows = 0;
    let sourceRecords = 0;
    let entryCount = 0;
    let declaredBytes = 0;
    let actualBytes = 0;
    try {
      for await (const entry of entries) {
        // Admit every raw entry before touching its body, including ignored and
        // empty members. Subtraction avoids unsafe aggregate arithmetic.
        check(++entryCount <= this.archiveEntries);
        const entryBytes = entry.declaredBytes;
        check(Number.isSafeInteger(entryBytes) && entryBytes >= 0);
        check(entryBytes <= this.archiveBytes - declaredBytes);
        declaredBytes += entryBytes;
        check(typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 512);
        check(!/[\\\x00-\x1f\x7f:]/.test(entry.path) && !entry.path.startsWith('/'));
        const path = entry.kind === 'directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
        check(path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
        check(entry.kind === 'file' || entry.kind === 'directory');
        check(entry.linkTarget === undefined);
        if (entry.kind === 'directory') check(entryBytes === 0);
        const table = TABLES.find((table) => path === `db/${table}` || path === `db/${table}.header`);
        if (table) {
          check(entry.kind === 'file' && !seen.has(path));
          seen.add(path);
        }
        const isHeader = table !== undefined && path.endsWith('.header');
        let lines = 0;
        // readEntry checks actual <= declared before scanning each chunk, so an
        // underreported body cannot consume the remaining archive allowance.
        actualBytes += await this.readEntry(entry, entryBytes, table !== undefined, (raw) => {
          lines++;
          if (!table) return;
          if (isHeader) {
            check(lines === 1);
            const names = utf8.decode(raw).split('\t');
            check(names.length === COLUMNS[table].length && new Set(names).size === names.length);
            check(names.every((name) => COLUMNS[table].includes(name)));
            headers.set(table, names);
          } else {
            check(++inputRows <= this.maxRows);
            const header = headers.get(table);
            if (header) sourceRecords += this.insert(source, runId, table, header, raw);
            else {
              this.db
                .query(`INSERT INTO vndb_table_spool (source,run_id,table_name,sequence,raw)
                VALUES (?,?,?,?,?)`)
                .run(source, runId, table, lines, raw);
            }
            check(sourceRecords <= this.maxSourceRecords);
          }
        });
        check(Number.isSafeInteger(actualBytes) && actualBytes === declaredBytes);
        if (isHeader && table) {
          check(lines === 1);
          let after = 0;
          for (;;) {
            const rows = this.db
              .query(`SELECT sequence,raw FROM vndb_table_spool
              WHERE source=? AND run_id=? AND table_name=? AND sequence>?
              ORDER BY sequence LIMIT ?`)
              .all(source, runId, table, after, BATCH) as { sequence: number; raw: Uint8Array }[];
            this.withRows(rows.length, () => {
              for (const row of rows) {
                sourceRecords += this.insert(source, runId, table, headers.get(table)!, row.raw);
                check(sourceRecords <= this.maxSourceRecords);
                this.db
                  .query(`DELETE FROM vndb_table_spool
                WHERE source=? AND run_id=? AND table_name=? AND sequence=?`)
                  .run(source, runId, table, row.sequence);
                after = row.sequence;
              }
            });
            if (rows.length < BATCH) break;
          }
        }
      }
      check(seen.size === 6 && sourceRecords > 0);
      this.validate(source, runId);
      this.db
        .query(`UPDATE vndb_table_runs SET state='ready' WHERE source=? AND run_id=? AND state='staging'`)
        .run(source, runId);
    } catch (error) {
      // No archive path, cell, ignored bytes or upstream exception is persisted or
      // exposed in diagnostics. Failure is durable even if later cleanup fails.
      this.db
        .query(`UPDATE vndb_table_runs SET state='failed',source_records=0,staged_rows=0,staged_bytes=0
        WHERE source=? AND run_id=?`)
        .run(source, runId);
      this.cleanup(source, runId);
      if (error instanceof DumpInputError) throw error;
      throw new Error('VNDB table staging failed');
    }
  }

  private async readEntry(
    entry: ArchiveEntry,
    declaredBytes: number,
    supported: boolean,
    row: (raw: Uint8Array) => void,
  ) {
    // Ignored entries have no row buffer and never reach a decoder, SQL or logs.
    const buffer = supported ? new Uint8Array(ROW_BYTES) : null;
    const memory = new DumpMemory(createDumpCounters());
    memory.hold(1, buffer, 'line');
    let used = 0;
    let bytes = 0;
    try {
      for await (const chunk of entry.bytes) {
        // Check the entire allocation before retaining, reading or scanning even
        // ignored entries: a tiny view can otherwise pin a whole source file.
        check(chunk instanceof Uint8Array && chunk.buffer.byteLength <= this.chunkBytes);
        memory.hold(0, chunk, 'input');
        try {
          bytes += chunk.byteLength;
          check(Number.isSafeInteger(bytes) && bytes <= declaredBytes);
          if (!buffer) continue;
          for (const byte of chunk) {
            if (byte === 10) {
              check(used > 0);
              this.observeRows(1);
              row(buffer.subarray(0, used));
              used = 0;
            } else {
              check(used < ROW_BYTES);
              buffer[used++] = byte;
            }
          }
        } finally {
          memory.hold(0, null);
        }
      }
      check(bytes === declaredBytes && used === 0);
      return bytes;
    } finally {
      memory.close();
    }
  }

  private project(
    table: Table,
    header: string[],
    raw: Uint8Array,
  ): { id: string; child: string; payload: string; vn: boolean } | null {
    const values = columns(raw);
    check(values.length === header.length);
    const cells = Object.fromEntries(header.map((name, index) => [name, values[index]!])) as Record<
      string,
      string | null
    >;
    const id = nativeId(cells.id, table !== 'entry_meta');
    if (table === 'entry_meta' && id[0] !== 'v') return null;
    let child = '';
    let record: GroupedRecord['vn'] | Title | Metadata;
    if (table === 'vn') {
      for (const name of ['image', 'c_image']) {
        const value = cells[name];
        if (value !== null) {
          check(typeof value === 'string' && /^cv[1-9][0-9]{0,9}$/.test(value));
          integer(value.slice(2), 2147483647, 1);
        }
      }
      const olang = language(cells.olang);
      const c_votecount = integer(cells.c_votecount, 2147483647);
      integer(cells.c_lengthnum, 2147483647);
      for (const name of ['c_rating', 'c_average', 'c_length'])
        if (cells[name] !== null) integer(cells[name], name === 'c_length' ? 32767 : 1000);
      const c_average = cells.c_average === null ? null : integer(cells.c_average, 1000);
      integer(cells.length, 5);
      integer(cells.devstatus, 2);
      record = { id, olang, c_votecount, c_average, alias: cells.alias ?? null };
    } else if (table === 'vn_titles') {
      child = language(cells.lang);
      check(cells.official === 't' || cells.official === 'f');
      const title = required(cells.title);
      check(title.length > 0);
      record = { id, lang: child, official: cells.official === 't', title, latin: cells.latin! };
      // The preceding header/column check guarantees latin is a string or null.
    } else {
      record = {
        id,
        created: timestamp(cells.created),
        lastmod: timestamp(cells.lastmod),
        revision: integer(cells.revision, 32767, 1),
        num_edits: integer(cells.num_edits, 32767),
        num_users: integer(cells.num_users, 32767),
      };
    }
    return { id, child, payload: JSON.stringify(record), vn: table === 'vn' };
  }

  private insert(source: string, run: string, table: Table, header: string[], raw: Uint8Array): number {
    const projected = this.project(table, header, raw);
    if (!projected) return 0;
    this.db
      .query(`INSERT INTO vndb_table_rows (source,run_id,table_name,id,id_number,child,payload)
      VALUES (?,?,?,?,?,?,?)`)
      .run(source, run, table, projected.id, Number(projected.id.slice(1)), projected.child, projected.payload);
    this.options.observer?.onRowWrite?.();
    this.db
      .query(`UPDATE vndb_table_runs SET staged_rows=staged_rows+1,staged_bytes=staged_bytes+?,
      source_records=source_records+? WHERE source=? AND run_id=?`)
      .run(new TextEncoder().encode(projected.payload).length, projected.vn ? 1 : 0, source, run);
    return projected.vn ? 1 : 0;
  }

  private titles(source: string, run: string, id: string): Title[] {
    const rows = this.db
      .query(`SELECT payload FROM vndb_table_rows
      WHERE source=? AND run_id=? AND table_name='vn_titles' AND id=? AND child>?
      ORDER BY child LIMIT ?`)
      .all(source, run, id, '', this.children + 1) as { payload: string }[];
    this.observeRows(rows.length);
    check(rows.length > 0 && rows.length <= this.children);
    return rows.map((row) => JSON.parse(row.payload) as Title);
  }

  private metadata(source: string, run: string, id: string): Metadata {
    const row = this.db
      .query(`SELECT payload FROM vndb_table_rows
      WHERE source=? AND run_id=? AND table_name='entry_meta' AND id=? AND child=''`)
      .get(source, run, id) as { payload: string } | null;
    check(row);
    this.observeRows(1);
    return JSON.parse(row.payload) as Metadata;
  }

  private validate(source: string, run: string) {
    // Traverse only S supplied rows. Every parent/child check is an indexed seek;
    // neither prior runs nor other sources participate in validation.
    for (const table of TABLES) {
      let id = '';
      let child = '';
      for (;;) {
        const rows = this.db
          .query(`SELECT id,child FROM vndb_table_rows
          WHERE source=? AND run_id=? AND table_name=? AND (id,child)>(?,?)
          ORDER BY id,child LIMIT ?`)
          .all(source, run, table, id, child, BATCH) as Stored[];
        this.withRows(rows.length, () => {
          for (const row of rows) {
            if (table === 'vn') {
              this.titles(source, run, row.id);
              this.metadata(source, run, row.id);
            } else {
              check(
                this.db
                  .query(`SELECT id FROM vndb_table_rows
              WHERE source=? AND run_id=? AND table_name='vn' AND id=? AND child=''`)
                  .get(source, run, row.id),
              );
            }
            id = row.id;
            child = row.child;
          }
        });
        if (rows.length < BATCH) break;
      }
    }
  }

  page(source: string, runId: string, options: { after: string | null; limit: number }) {
    identity(source, runId);
    bounded(options.limit, this.pageSize);
    if (options.after !== null) nativeId(options.after);
    check(this.inspect(source, runId).state === 'ready');
    const rows = this.db
      .query(`SELECT id,payload FROM vndb_table_rows
      WHERE source=? AND run_id=? AND table_name='vn' AND id_number>? AND child=''
      ORDER BY id_number LIMIT ?`)
      .all(source, runId, options.after === null ? 0 : Number(options.after.slice(1)), options.limit + 1) as {
      id: string;
      payload: string;
    }[];
    const records = rows.slice(0, options.limit).map(({ id, payload }) => {
      const entry_meta = this.metadata(source, runId, id);
      const vn = JSON.parse(payload) as GroupedRecord['vn'];
      const record: GroupedRecord = { vn, vn_titles: this.titles(source, runId, id), entry_meta };
      return { key: id, revision: entry_meta.revision, record };
    });
    this.observeRows(rows.length + records.reduce((count, row) => count + row.record.vn_titles.length + 1, 0));
    return { records, next: rows.length > options.limit ? records.at(-1)!.key : null };
  }

  private async stageTracked(
    source: string,
    runId: string,
    entries: AsyncIterable<ArchiveEntry>,
    tracking: VndbStageTracking,
  ): Promise<void> {
    const identity = admitVndbAcquisitionIdentity(tracking.identity);
    check(identity.childCap === this.children);
    check(identity.maxRows === this.maxRows);
    check(identity.maxSourceRecords === this.maxSourceRecords);
    check(identity.maxArchiveBytes === this.archiveBytes);
    check(identity.maxArchiveEntries === this.archiveEntries);
    const stored = this.checkpoint(source, runId);
    if (tracking.resume) {
      check(stored);
      check(stored.identity.sha256 === identity.sha256 && stored.identity.bytes === identity.bytes);
      const run = this.inspect(source, runId);
      check(run.state === 'new' || run.state === 'staging');
      if (run.state === 'new') {
        const started = this.db
          .query(`UPDATE vndb_table_runs SET state='staging'
          WHERE source=? AND run_id=? AND state='new' AND child_cap=?`)
          .run(source, runId, this.children);
        check(started.changes === 1);
      }
    } else {
      check(!stored || stored.lastCompleteOrdinal === 0);
      const started = this.db
        .query(`UPDATE vndb_table_runs SET state='staging'
        WHERE source=? AND run_id=? AND state='new' AND child_cap=?`)
        .run(source, runId, this.children);
      check(started.changes === 1);
      if (!stored) this.writeCheckpoint(source, runId, identity, emptyCheckpoint(identity));
    }
    const cursor = this.cursorFrom(source, runId, identity);
    let inputRows = this.committedCopyLines(source, runId);
    let sourceRecords = this.inspect(source, runId).sourceRecords;
    let entryCount = cursor.lastCompleteOrdinal + (cursor.currentOrdinal ? 1 : 0);
    let declaredBytes = this.committedDeclaredBytes(source, runId);
    let actualBytes = declaredBytes;
    try {
      let ordinal = 0;
      for await (const entry of entries) {
        ordinal++;
        const prefix = ordinal <= cursor.lastCompleteOrdinal;
        const current = ordinal === cursor.currentOrdinal && cursor.currentOrdinal > 0;
        if (!prefix && !current) {
          check(++entryCount <= this.archiveEntries);
          const entryBytes = entry.declaredBytes;
          check(Number.isSafeInteger(entryBytes) && entryBytes >= 0);
          check(entryBytes <= this.archiveBytes - declaredBytes);
          declaredBytes += entryBytes;
        }
        const admitted = this.admitEntry(entry);
        if (prefix) {
          await this.replayMember(source, runId, entry, admitted, ordinal, cursor, tracking, false);
          continue;
        }
        if (current) {
          await this.replayMember(source, runId, entry, admitted, ordinal, cursor, tracking, true);
          if (cursor.phase === 'spool-drain' && admitted.table && admitted.isHeader)
            sourceRecords = this.inspect(source, runId).sourceRecords;
          continue;
        }
        actualBytes += await this.loadMember(source, runId, entry, admitted, ordinal, cursor, tracking, () => {
          inputRows++;
          check(inputRows <= this.maxRows);
        });
        check(Number.isSafeInteger(actualBytes) && actualBytes === declaredBytes);
        sourceRecords = this.inspect(source, runId).sourceRecords;
        check(sourceRecords <= this.maxSourceRecords);
      }
      check(cursor.lastCompleteOrdinal >= 6);
      const seen = this.requiredRoles(source, runId);
      check(seen === 6 && sourceRecords > 0);
      this.commitCursor(source, runId, { ...cursor, phase: 'validating', archiveComplete: true });
      tracking.onCommitted?.(this.inspect(source, runId).stagedRows);
      this.validate(source, runId);
      this.db.transaction(() => {
        this.options.observer?.onBeforeCheckpoint?.();
        this.db
          .query(`UPDATE vndb_table_runs SET state='ready' WHERE source=? AND run_id=? AND state='staging'`)
          .run(source, runId);
        this.clearCheckpoint(source, runId);
      })();
    } catch (error) {
      if (interrupted(error)) throw error;
      this.db
        .query(`UPDATE vndb_table_runs SET state='failed',source_records=0,staged_rows=0,staged_bytes=0
        WHERE source=? AND run_id=?`)
        .run(source, runId);
      this.cleanup(source, runId);
      if (error instanceof DumpInputError || error instanceof VndbAcquisitionError) throw error;
      throw new Error('VNDB table staging failed', { cause: error });
    }
  }

  private admitEntry(entry: ArchiveEntry) {
    const entryBytes = entry.declaredBytes;
    check(Number.isSafeInteger(entryBytes) && entryBytes >= 0);
    check(typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 512);
    check(!/[\\\x00-\x1f\x7f:]/.test(entry.path) && !entry.path.startsWith('/'));
    const path = entry.kind === 'directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
    check(path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
    check(entry.kind === 'file' || entry.kind === 'directory');
    check(entry.linkTarget === undefined);
    if (entry.kind === 'directory') check(entryBytes === 0);
    const table = TABLES.find((name) => path === `db/${name}` || path === `db/${name}.header`);
    const isHeader = table !== undefined && path.endsWith('.header');
    const role = table ? (isHeader ? `${table}.header` : table) : 'ignored';
    return { path, entryBytes, table, isHeader, role, kind: entry.kind };
  }

  private async replayMember(
    source: string,
    runId: string,
    entry: ArchiveEntry,
    admitted: ReturnType<VndbTablesStore['admitEntry']>,
    ordinal: number,
    cursor: Cursor,
    tracking: VndbStageTracking,
    continueAfterPrefix: boolean,
  ) {
    const stored = this.member(source, runId, ordinal);
    check(stored);
    check(stored.path_digest === memberPathDigest(admitted.path));
    check(stored.declared_bytes === admitted.entryBytes);
    check(stored.kind === admitted.kind);
    check(stored.role === admitted.role);
    const continueAt = continueAfterPrefix && !stored.complete ? cursor.currentLines : stored.lines;
    let lines = 0;
    await this.readEntry(entry, admitted.entryBytes, admitted.table !== undefined, (raw) => {
      lines++;
      if (!admitted.table) return;
      if (lines <= continueAt) {
        this.verifyLine(source, runId, admitted, lines, raw, cursor);
        tracking.onVerified?.(1);
        return;
      }
      if (!continueAfterPrefix) check(false);
      this.commitLine(source, runId, admitted, ordinal, lines, raw, cursor, tracking);
    });
    check(continueAfterPrefix || stored.complete === 1);
    if (continueAfterPrefix && admitted.isHeader && admitted.table)
      this.drainSpool(source, runId, admitted.table, cursor, tracking, cursor.phase === 'spool-drain');
    if (continueAfterPrefix && (cursor.currentOrdinal === ordinal || !stored.complete))
      this.completeMember(source, runId, ordinal, lines, cursor);
  }

  private async loadMember(
    source: string,
    runId: string,
    entry: ArchiveEntry,
    admitted: ReturnType<VndbTablesStore['admitEntry']>,
    ordinal: number,
    cursor: Cursor,
    tracking: VndbStageTracking,
    counted: () => void,
  ) {
    if (admitted.table) {
      const duplicate = this.db
        .query(`SELECT ordinal FROM vndb_acquisition_members
        WHERE source=? AND run_id=? AND role=?`)
        .get(source, runId, admitted.role) as { ordinal: number } | null;
      check(!duplicate);
    }
    this.db.transaction(() => {
      this.options.observer?.onBeforeCheckpoint?.();
      this.db
        .query(
          `INSERT INTO vndb_acquisition_members
          (source,run_id,ordinal,path_digest,declared_bytes,kind,role,lines,complete)
          VALUES (?,?,?,?,?,?,?,0,0)`,
        )
        .run(
          source,
          runId,
          ordinal,
          memberPathDigest(admitted.path),
          admitted.entryBytes,
          admitted.kind,
          admitted.role,
        );
      cursor.currentOrdinal = ordinal;
      cursor.currentLines = 0;
      cursor.currentRole = admitted.role;
      cursor.phase = 'loading';
      this.writeCheckpoint(source, runId, cursor.identity, cursor);
    })();
    const bytes = await this.readEntry(entry, admitted.entryBytes, admitted.table !== undefined, (raw) => {
      if (!admitted.table) return;
      counted();
      this.commitLine(source, runId, admitted, ordinal, cursor.currentLines + 1, raw, cursor, tracking);
    });
    check(!admitted.isHeader || cursor.currentLines === 1);
    if (admitted.isHeader && admitted.table) this.drainSpool(source, runId, admitted.table, cursor, tracking, false);
    this.completeMember(source, runId, ordinal, cursor.currentLines, cursor);
    return bytes;
  }

  private verifyLine(
    source: string,
    runId: string,
    admitted: ReturnType<VndbTablesStore['admitEntry']>,
    lines: number,
    raw: Uint8Array,
    cursor: Cursor,
  ) {
    if (!admitted.table) return;
    if (admitted.isHeader) {
      check(lines === 1);
      const names = utf8.decode(raw).split('\t');
      const header = cursor.headers.get(admitted.table);
      check(header && header.length === names.length && header.every((name, index) => name === names[index]));
      return;
    }
    const spool = this.db
      .query(
        `SELECT raw FROM vndb_table_spool
        WHERE source=? AND run_id=? AND table_name=? AND sequence=?`,
      )
      .get(source, runId, admitted.table, lines) as { raw: Uint8Array } | null;
    if (spool) {
      check(sameBytes(new Uint8Array(spool.raw), raw));
      return;
    }
    const header = cursor.headers.get(admitted.table);
    check(header);
    const projected = this.project(admitted.table, header, raw);
    if (!projected) return;
    const row = this.db
      .query(
        `SELECT payload FROM vndb_table_rows
          WHERE source=? AND run_id=? AND table_name=? AND id=? AND child=?`,
      )
      .get(source, runId, admitted.table, projected.id, projected.child) as { payload: string } | null;
    check(row?.payload === projected.payload);
  }

  private commitLine(
    source: string,
    runId: string,
    admitted: ReturnType<VndbTablesStore['admitEntry']>,
    ordinal: number,
    lines: number,
    raw: Uint8Array,
    cursor: Cursor,
    tracking: VndbStageTracking,
  ) {
    const table = admitted.table;
    check(table);
    this.db.transaction(() => {
      this.options.observer?.onBeforeCheckpoint?.();
      if (admitted.isHeader) {
        check(lines === 1);
        const names = utf8.decode(raw).split('\t');
        check(names.length === COLUMNS[table].length && new Set(names).size === names.length);
        check(names.every((name) => COLUMNS[table].includes(name)));
        cursor.headers.set(table, names);
      } else {
        const header = cursor.headers.get(table);
        if (header) this.insert(source, runId, table, header, raw);
        else
          this.db
            .query(`INSERT INTO vndb_table_spool (source,run_id,table_name,sequence,raw)
            VALUES (?,?,?,?,?)`)
            .run(source, runId, table, lines, raw);
      }
      cursor.currentOrdinal = ordinal;
      cursor.currentLines = lines;
      cursor.currentRole = admitted.role;
      cursor.phase = 'loading';
      this.db
        .query(`UPDATE vndb_acquisition_members SET lines=? WHERE source=? AND run_id=? AND ordinal=?`)
        .run(lines, source, runId, ordinal);
      this.writeCheckpoint(source, runId, cursor.identity, cursor);
    })();
    tracking.onCommitted?.(1);
  }

  private drainSpool(
    source: string,
    runId: string,
    table: Table,
    cursor: Cursor,
    tracking: VndbStageTracking,
    resume: boolean,
  ) {
    let after = resume ? cursor.spoolAfter : 0;
    for (;;) {
      const rows = this.db
        .query(`SELECT sequence,raw FROM vndb_table_spool
        WHERE source=? AND run_id=? AND table_name=? AND sequence>?
        ORDER BY sequence LIMIT ?`)
        .all(source, runId, table, after, BATCH) as { sequence: number; raw: Uint8Array }[];
      if (!rows.length) break;
      this.db.transaction(() => {
        this.options.observer?.onBeforeCheckpoint?.();
        this.withRows(rows.length, () => {
          for (const row of rows) {
            this.insert(source, runId, table, cursor.headers.get(table)!, row.raw);
            this.db
              .query(`DELETE FROM vndb_table_spool
              WHERE source=? AND run_id=? AND table_name=? AND sequence=?`)
              .run(source, runId, table, row.sequence);
            after = row.sequence;
          }
        });
        cursor.phase = rows.length < BATCH ? 'loading' : 'spool-drain';
        cursor.spoolTable = rows.length < BATCH ? '' : table;
        cursor.spoolAfter = after;
        this.writeCheckpoint(source, runId, cursor.identity, cursor);
      })();
      tracking.onCommitted?.(rows.length);
      if (rows.length < BATCH) break;
    }
  }

  private completeMember(source: string, runId: string, ordinal: number, lines: number, cursor: Cursor) {
    this.db.transaction(() => {
      this.options.observer?.onBeforeCheckpoint?.();
      this.db
        .query(`UPDATE vndb_acquisition_members SET lines=?,complete=1
        WHERE source=? AND run_id=? AND ordinal=?`)
        .run(lines, source, runId, ordinal);
      cursor.lastCompleteOrdinal = ordinal;
      cursor.currentOrdinal = 0;
      cursor.currentLines = 0;
      cursor.currentRole = '';
      cursor.phase = 'loading';
      cursor.spoolTable = '';
      cursor.spoolAfter = 0;
      this.writeCheckpoint(source, runId, cursor.identity, cursor);
    })();
  }

  private commitCursor(source: string, runId: string, cursor: Cursor) {
    this.db.transaction(() => {
      this.options.observer?.onBeforeCheckpoint?.();
      this.writeCheckpoint(source, runId, cursor.identity, cursor);
    })();
  }

  private cursorFrom(source: string, runId: string, identity: VndbAcquisitionIdentity): Cursor {
    const stored = this.checkpoint(source, runId);
    check(stored);
    const headers = new Map<Table, string[]>();
    for (const table of TABLES) {
      const names = stored.headers[table];
      if (names) headers.set(table, [...names]);
    }
    return {
      identity,
      lastCompleteOrdinal: stored.lastCompleteOrdinal,
      currentOrdinal: stored.currentOrdinal,
      currentLines: stored.currentLines,
      currentRole: stored.currentRole,
      spoolTable: stored.spoolTable,
      spoolAfter: stored.spoolAfter,
      phase: stored.phase,
      headers,
      archiveComplete: stored.archiveComplete,
    };
  }

  private member(source: string, runId: string, ordinal: number): MemberRow | null {
    return this.db
      .query(
        `SELECT ordinal,path_digest,declared_bytes,kind,role,lines,complete
        FROM vndb_acquisition_members WHERE source=? AND run_id=? AND ordinal=?`,
      )
      .get(source, runId, ordinal) as MemberRow | null;
  }

  private committedDeclaredBytes(source: string, runId: string): number {
    const row = this.db
      .query(`SELECT COALESCE(SUM(declared_bytes),0) AS total FROM vndb_acquisition_members
      WHERE source=? AND run_id=?`)
      .get(source, runId) as { total: number };
    return Number(row.total);
  }

  private requiredRoles(source: string, runId: string): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM vndb_acquisition_members
      WHERE source=? AND run_id=? AND complete=1 AND role<>'ignored'`)
      .get(source, runId) as { n: number };
    return Number(row.n);
  }

  private committedCopyLines(source: string, runId: string): number {
    const row = this.db
      .query(`SELECT COALESCE(SUM(lines),0) AS n FROM vndb_acquisition_members
      WHERE source=? AND run_id=? AND role IN ('vn','vn_titles','entry_meta')`)
      .get(source, runId) as { n: number };
    return Number(row.n);
  }

  private writeCheckpoint(source: string, runId: string, identity: VndbAcquisitionIdentity, cursor: Cursor) {
    const headers: Record<string, string[]> = {};
    for (const [table, names] of cursor.headers) headers[table] = names;
    this.db
      .query(
        `INSERT INTO vndb_acquisition_checkpoints (
          source,run_id,version,sha256,bytes,archive_format,codec,source_alias,source_kind,
          converter_revision,projection,child_cap,max_rows,max_source_records,max_archive_bytes,
          max_archive_entries,decode_budget,last_complete_ordinal,current_ordinal,current_lines,
          current_role,spool_table,spool_after,phase,headers_json,archive_complete)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source,run_id) DO UPDATE SET
          last_complete_ordinal=excluded.last_complete_ordinal,
          current_ordinal=excluded.current_ordinal,
          current_lines=excluded.current_lines,
          current_role=excluded.current_role,
          spool_table=excluded.spool_table,
          spool_after=excluded.spool_after,
          phase=excluded.phase,
          headers_json=excluded.headers_json,
          archive_complete=excluded.archive_complete`,
      )
      .run(
        source,
        runId,
        VNDB_ACQUISITION_CHECKPOINT_VERSION,
        identity.sha256,
        identity.bytes,
        identity.archiveFormat,
        identity.codec,
        identity.sourceAlias,
        identity.sourceKind,
        identity.converterRevision,
        identity.projection,
        identity.childCap,
        identity.maxRows,
        identity.maxSourceRecords,
        identity.maxArchiveBytes,
        identity.maxArchiveEntries,
        identity.decodeBudget,
        cursor.lastCompleteOrdinal,
        cursor.currentOrdinal,
        cursor.currentLines,
        cursor.currentRole,
        cursor.spoolTable,
        cursor.spoolAfter,
        cursor.phase,
        JSON.stringify(headers),
        cursor.archiveComplete ? 1 : 0,
      );
  }

  private clearCheckpoint(source: string, run: string) {
    this.db.query('DELETE FROM vndb_acquisition_checkpoints WHERE source=? AND run_id=?').run(source, run);
    for (;;) {
      const rows = this.db
        .query(`SELECT ordinal FROM vndb_acquisition_members
        WHERE source=? AND run_id=? ORDER BY ordinal LIMIT ?`)
        .all(source, run, BATCH) as { ordinal: number }[];
      for (const row of rows)
        this.db
          .query('DELETE FROM vndb_acquisition_members WHERE source=? AND run_id=? AND ordinal=?')
          .run(source, run, row.ordinal);
      if (rows.length < BATCH) break;
    }
  }

  private cleanup(source: string, run: string) {
    this.clearCheckpoint(source, run);
    for (;;) {
      const rows = this.db
        .query(`SELECT table_name,id,child FROM vndb_table_rows
        WHERE source=? AND run_id=? ORDER BY table_name,id,child LIMIT ?`)
        .all(source, run, BATCH) as { table_name: string; id: string; child: string }[];
      for (const row of rows)
        this.db
          .query(`DELETE FROM vndb_table_rows
        WHERE source=? AND run_id=? AND table_name=? AND id=? AND child=?`)
          .run(source, run, row.table_name, row.id, row.child);
      if (rows.length < BATCH) break;
    }
    for (;;) {
      const rows = this.db
        .query(`SELECT table_name,sequence FROM vndb_table_spool
        WHERE source=? AND run_id=? ORDER BY table_name,sequence LIMIT ?`)
        .all(source, run, BATCH) as { table_name: string; sequence: number }[];
      for (const row of rows)
        this.db
          .query(`DELETE FROM vndb_table_spool
        WHERE source=? AND run_id=? AND table_name=? AND sequence=?`)
          .run(source, run, row.table_name, row.sequence);
      if (rows.length < BATCH) break;
    }
  }
}
