import { randomUUID } from 'node:crypto';
import type { SourceRecord } from '@rezics/conversion';
import { convertVndb } from '@rezics/conversion/vndb';
import { readArchive } from './archive.ts';
import { DumpInputError } from './dump-input.ts';
import { DEFAULT_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';
import type { SourceRegistration } from './import-contract.ts';
import type { Importer, ImportRunOptions } from './importer.ts';
import { createSourceRegistration } from './source-registry.ts';
import {
  evaluateVndbResume,
  VndbAcquisitionError,
  VNDB_ACQUISITION_MISSING,
  type VndbAcquisitionIdentity,
} from './vndb-acquisition.ts';
import { DEFAULT_VNDB_ARCHIVE_BYTES, VndbTablesStore, type VndbStageTracking } from './vndb-tables.ts';

export type VndbEntries = Parameters<VndbTablesStore['stage']>[2];
export class VndbInputError extends Error {
  constructor() {
    super('VNDB input is incomplete or invalid');
  }
}

/** Page a ready table acquisition into source records without an importer lease. */
export async function* iterateVndbRecords(
  tables: VndbTablesStore,
  source: string,
  run: string,
  options: { pageSize?: number; onPageRecords?(count: number): void; signal?: AbortSignal } = {},
): AsyncGenerator<SourceRecord> {
  let after: string | null = null;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Import interrupted', 'AbortError');
    const page = tables.page(source, run, { after, limit: options.pageSize ?? 16 });
    options.onPageRecords?.(page.records.length);
    for (const row of page.records)
      yield { source: 'vndb', key: row.key, revision: String(row.revision), payload: row.record };
    if (page.next === null) return;
    after = page.next;
  }
}

/** Validated table acquisition and ordinary publication share the importer's durable handle.
 * The only additional durable metadata links a table acquisition to RunStore's
 * completed generation. Record revisions/digests and the baseline remain owned by RunStore.
 */
export class VndbMaterialization {
  readonly tables: VndbTablesStore;
  private readonly source: string;

  constructor(
    private readonly importer: Importer,
    private readonly registration: SourceRegistration = createSourceRegistration('vndb'),
    private readonly options: ConstructorParameters<typeof VndbTablesStore>[1] = {},
  ) {
    if (registration.sourceKind !== 'vndb') throw new TypeError('Expected VNDB registration');
    this.source = registration.source;
    const db = importer.session.store.database;
    this.tables = new VndbTablesStore(db, options);
    const columns = db.query('PRAGMA table_info(vndb_table_runs)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'materialized_generation'))
      db.exec('ALTER TABLE vndb_table_runs ADD COLUMN materialized_generation TEXT');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS vndb_materialized_generation
      ON vndb_table_runs(source,materialized_generation) WHERE materialized_generation IS NOT NULL`);
  }

  begin(): string {
    const run = randomUUID();
    this.tables.begin(this.source, run);
    return run;
  }

  beginCheckpointed(identity: VndbAcquisitionIdentity): string {
    const run = randomUUID();
    this.tables.beginCheckpointed(this.source, run, identity);
    return run;
  }

  acquisition(run: string) {
    const inspect = this.tables.inspect(this.source, run);
    const row = this.importer.session.store.database
      .query(`SELECT materialized_generation AS generation FROM vndb_table_runs
        WHERE source=? AND run_id=?`)
      .get(this.source, run) as { generation: string | null } | null;
    return {
      ...inspect,
      materializedGeneration: row?.generation ?? null,
      checkpoint: this.tables.checkpoint(this.source, run),
    };
  }

  resumeCompatibility(run: string, identity: VndbAcquisitionIdentity) {
    let inspect: ReturnType<VndbMaterialization['acquisition']>;
    try {
      inspect = this.acquisition(run);
    } catch {
      throw new VndbAcquisitionError('missing', VNDB_ACQUISITION_MISSING);
    }
    return evaluateVndbResume(inspect.checkpoint, identity, {
      status: inspect.state,
      materializedGeneration: inspect.materializedGeneration,
    });
  }

  async stage(run: string, entries: VndbEntries, tracking?: VndbStageTracking): Promise<void> {
    try {
      await this.tables.stage(this.source, run, entries, tracking);
    } catch (error) {
      if (error instanceof DumpInputError || error instanceof VndbAcquisitionError) throw error;
      throw new VndbInputError();
    }
  }

  async stageArchive(
    run: string,
    bytes: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal; onProgress?: NonNullable<Parameters<typeof readArchive>[1]>['onProgress'] } = {},
  ): Promise<void> {
    await this.stage(
      run,
      readArchive(bytes, {
        maxTotalBytes: DEFAULT_VNDB_ARCHIVE_BYTES,
        maxChunkBytes: DEFAULT_DUMP_CHUNK_BYTES,
        maxMetadataBytes: 4096,
        onProgress: () => {},
        ...options,
      }),
    );
  }

  page(run: string, after: string | null, limit: number) {
    const page = this.tables.page(this.source, run, { after, limit });
    return {
      records: page.records.map((row) => ({
        ...row,
        output: convertVndb(
          { external_id: row.key, record_revision: String(row.revision), record: row.record },
          { source: this.source },
          { converterRevision: this.registration.converter_revision },
        ),
      })),
      next: page.next,
    };
  }

  async commit(run: string, options: ImportRunOptions & { onPageRecords?(count: number): void } = {}) {
    // Check before entering Importer: an incomplete archive must not even resume
    // older remote work or acquire a RunStore lease.
    if (this.tables.inspect(this.source, run).state !== 'ready') throw new VndbInputError();
    const { onPageRecords, ...runOptions } = options;
    const self = this;
    async function* records(): AsyncGenerator<SourceRecord> {
      // Importer has begun its actual run before requesting this first record.
      // Persist the acquisition link before any possible publication, including
      // a crash followed by resume with a different archive at the CLI boundary.
      const active = self.importer.session.store.activeRun(self.source);
      if (!active) throw new Error('VNDB publication has no active durable run');
      self.importer.session.store.database
        .query(`UPDATE vndb_table_runs SET materialized_generation=?
          WHERE source=? AND run_id=? AND state='ready'
          AND (materialized_generation IS NULL OR materialized_generation<>?)`)
        .run(active.id, self.source, run, self.importer.session.store.source(self.source).generation ?? '');
      yield* iterateVndbRecords(self.tables, self.source, run, {
        ...(self.options?.pageSize === undefined ? {} : { pageSize: self.options.pageSize }),
        ...(onPageRecords === undefined ? {} : { onPageRecords }),
      });
    }
    return this.importer.runRecords(this.registration, records(), runOptions);
  }

  private linkedAcquisition(generation: string): string | null {
    const row = this.importer.session.store.database
      .query(`SELECT run_id FROM vndb_table_runs
        WHERE source=? AND materialized_generation=?`)
      .get(this.source, generation) as { run_id: string } | null;
    return row?.run_id ?? null;
  }

  baseline(key: string) {
    const store = this.importer.session.store;
    const generation = store.source(this.source).generation;
    const row = store.key(this.source, key).baseline;
    if (!generation || !row || row.state !== 'present') return null;
    const run = this.linkedAcquisition(generation);
    if (!run) return null;
    return {
      run,
      revision: Number(row.recordRevision),
      digest: row.digest,
      converterRevision: row.converter_revision,
    };
  }
}
