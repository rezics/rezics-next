import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import type { SourceId } from '@rezics/conversion';
import {
  ConversionDiagnosticError,
  ConversionDiagnosticsView,
  admitGenerationId,
  admitRecordKey,
  admitSourceId,
  decodeDiagnosticCursor,
  escapeDiagnosticText,
  importInvocationShape,
  isConversionDiagnosticPhase,
  type ConversionDiagnosticGenerationView,
  type ConversionDiagnosticPage,
  type ConversionDiagnosticPhase,
  type ConversionDiagnosticRecordView,
} from './conversion-diagnostics.ts';

const VALID_SOURCE = /^(?:bangumi|vndb|openlibrary|wikidata)$/;

export type DiagnosticsCliResult = {
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
};

export type DiagnosticsCliOptions = {
  signal?: AbortSignal;
  instrumentDatabase?: (database: Database) => Database;
  observer?: { onDatabaseOpen?(path: string): void };
};

class InputFailure extends Error {}

type Config =
  | 'help'
  | {
      source: SourceId;
      state: string;
      generation?: string;
      record?: string;
      limit: number;
      cursor?: string;
      phase?: ConversionDiagnosticPhase;
      format: 'json' | 'text';
    };

export function diagnosticsUsage(): string {
  return [
    'Usage: rezics-import diagnostics --source <bangumi|vndb|openlibrary|wikidata> --state <sqlite-path>',
    '       [--generation <id>] [--record <key>] [--limit <1..100>] [--cursor <token>] [--phase staging|application] [--format json|text]',
    'Options: --source --state --generation --record --limit --cursor --phase --format --help',
    'Reviews retained converter field omissions. Repair admitted source input and reimport through the ordinary CLI.',
  ].join('\n');
}

function parse(argv: readonly string[]): Config {
  if (!Array.isArray(argv) || argv.length > 64) throw new InputFailure();
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new InputFailure();
    totalBytes += Buffer.byteLength(argument);
    if (totalBytes > 16384) throw new InputFailure();
  }
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set([
    '--source',
    '--state',
    '--generation',
    '--record',
    '--limit',
    '--cursor',
    '--phase',
    '--format',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--help') throw new InputFailure();
    if (!valueFlags.has(flag) || values.has(flag)) throw new InputFailure();
    const value = argv[++index];
    if (value === undefined || valueFlags.has(value) || value === '--help' || value.length === 0)
      throw new InputFailure();
    values.set(flag, value);
  }
  const source = values.get('--source');
  const state = values.get('--state');
  if (!source || !VALID_SOURCE.test(source) || !state || !state.trim() || state === '-') throw new InputFailure();
  admitSourceId(source);
  const limitText = values.get('--limit');
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputFailure();
  const format = values.get('--format') ?? 'text';
  if (format !== 'json' && format !== 'text') throw new InputFailure();
  const result: Exclude<Config, 'help'> = { source: source as SourceId, state, limit, format };
  const generation = values.get('--generation');
  if (generation !== undefined) {
    admitGenerationId(generation);
    result.generation = generation;
  }
  const record = values.get('--record');
  if (record !== undefined) {
    admitRecordKey(record);
    result.record = record;
  }
  const cursor = values.get('--cursor');
  if (cursor !== undefined) result.cursor = cursor;
  const phase = values.get('--phase');
  if (phase !== undefined) {
    if (!isConversionDiagnosticPhase(phase)) throw new InputFailure();
    result.phase = phase;
  }
  return result;
}

function openState(path: string): { database: Database; close(): void; handles: number } {
  let fd: number | undefined;
  let database: Database | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new InputFailure();
    database = new Database(`/proc/self/fd/${fd}`, { readonly: true, create: false, strict: true });
    return {
      database,
      handles: 1,
      close() {
        try {
          database?.close();
        } finally {
          if (fd !== undefined) {
            closeSync(fd);
            fd = undefined;
          }
        }
      },
    };
  } catch (error) {
    if (database)
      try {
        database.close();
      } catch {
        // Preserve the original admission failure.
      }
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // The descriptor is already unusable.
      }
    if (error instanceof InputFailure) throw error;
    throw new InputFailure();
  }
}

function coverageLine(generation: ConversionDiagnosticGenerationView): string {
  if (generation.coverage === 'unsupported')
    return 'Evidence: unsupported on this database; conversion diagnostics require a current writer store.';
  if (generation.status === 'retired')
    return 'Evidence: deliberately retired; diagnostic vectors for this generation were removed and are unavailable.';
  if (generation.status === 'retiring')
    return 'Evidence: retirement is in progress; remaining diagnostic vectors are being removed and are unavailable for review.';
  if (generation.coverage === 'unavailable')
    return 'Evidence: unavailable for this generation; a recognized empty set is distinct from missing historical evidence.';
  const records = generation.diagnosticRecords ?? 0;
  const entries = generation.diagnosticEntries ?? 0;
  return `Evidence: recorded ${records} diagnostic-bearing records, ${entries} omissions.`;
}

function renderRecord(record: ConversionDiagnosticRecordView): string {
  const identity = [
    escapeDiagnosticText(record.recordKey),
    `digest=${record.digest}`,
    `converter=${escapeDiagnosticText(record.converterRevision)}`,
    `revision=${escapeDiagnosticText(record.recordRevision)}`,
    `phase=${record.phase}`,
  ].join('  ');
  const lines = [identity];
  if (!record.diagnostics.length) {
    lines.push('  (recognized empty diagnostic set)');
    return lines.join('\n');
  }
  for (const diagnostic of record.diagnostics) {
    const category = diagnostic.category ? `  category=${escapeDiagnosticText(diagnostic.category)}` : '';
    lines.push(`  ${escapeDiagnosticText(diagnostic.pointer)}  ${escapeDiagnosticText(diagnostic.code)}${category}`);
  }
  return lines.join('\n');
}

function renderText(
  generation: ConversionDiagnosticGenerationView,
  records: ConversionDiagnosticRecordView[],
  nextCursor: string | null,
  exact: boolean,
): string {
  if (!generation.generation && generation.status === 'missing')
    return 'No retained generation is available for this source.\n';
  const lines = [
    `Source: ${escapeDiagnosticText(generation.source)}`,
    `Generation: ${escapeDiagnosticText(generation.generation)} (${escapeDiagnosticText(generation.status)})`,
    coverageLine(generation),
  ];
  if (generation.live) lines.push('A live generation can change between invocations.');
  if (generation.coverage === 'recorded') {
    if (!records.length)
      lines.push(
        exact ? 'No retained diagnostic vector for this record.' : 'No diagnostic-bearing records on this page.',
      );
    else for (const record of records) lines.push(renderRecord(record));
    if (nextCursor) lines.push(`Next: --cursor ${nextCursor}`);
  }
  lines.push(
    'Omitted fields use converter codes and source JSON pointers. Supported facts are native-selected, not journal rows.',
  );
  lines.push(`Repair admitted local source input and reimport: ${importInvocationShape()}`);
  lines.push('See services/importer/README.md#conversion-field-omissions');
  return `${lines.join('\n')}\n`;
}

function renderJson(
  generation: ConversionDiagnosticGenerationView,
  records: ConversionDiagnosticRecordView[],
  nextCursor: string | null,
): string {
  const body: Record<string, unknown> = {
    version: 1,
    source: generation.source,
    generation: generation.generation,
    status: generation.status,
    live: generation.live,
    coverage: generation.coverage,
  };
  if (generation.coverage === 'recorded') {
    body.diagnosticRecords = generation.diagnosticRecords ?? 0;
    body.diagnosticEntries = generation.diagnosticEntries ?? 0;
  }
  body.records = records.map((record) => {
    const item: Record<string, unknown> = {
      recordKey: record.recordKey,
      phase: record.phase,
      digest: record.digest,
      converterRevision: record.converterRevision,
      recordRevision: record.recordRevision,
      diagnostics: record.diagnostics.map((diagnostic) => {
        const entry: Record<string, string> = { pointer: diagnostic.pointer, code: diagnostic.code };
        if (diagnostic.category !== undefined) entry.category = diagnostic.category;
        return entry;
      }),
    };
    return item;
  });
  body.nextCursor = nextCursor;
  body.resume = importInvocationShape();
  body.documentation = 'services/importer/README.md#conversion-field-omissions';
  return `${JSON.stringify(body)}\n`;
}

function output(
  format: 'json' | 'text',
  generation: ConversionDiagnosticGenerationView,
  records: ConversionDiagnosticRecordView[],
  nextCursor: string | null,
  exact: boolean,
): string {
  return format === 'json'
    ? renderJson(generation, records, nextCursor)
    : renderText(generation, records, nextCursor, exact);
}

/** Read-only review of retained converter diagnostics. Never opens credentials, network or a writer. */
export async function runDiagnosticsCli(
  argv: readonly string[],
  options: DiagnosticsCliOptions = {},
): Promise<DiagnosticsCliResult> {
  const signal = options.signal ?? new AbortController().signal;
  let config: Exclude<Config, 'help'>;
  try {
    const parsed = parse(argv);
    if (parsed === 'help') return { code: 0, stdout: `${diagnosticsUsage()}\n`, stderr: '', openHandles: 0 };
    config = parsed;
  } catch {
    return { code: 2, stdout: '', stderr: 'Invalid diagnostics arguments.\n', openHandles: 0 };
  }
  if (signal.aborted) return { code: 130, stdout: '', stderr: 'Diagnostics interrupted.\n', openHandles: 0 };
  let opened: { database: Database; close(): void; handles: number } | undefined;
  let view: ConversionDiagnosticsView | undefined;
  try {
    options.observer?.onDatabaseOpen?.(config.state);
    opened = openState(config.state);
    const database = options.instrumentDatabase?.(opened.database) ?? opened.database;
    if (database !== opened.database) opened.database = database;
    view = new ConversionDiagnosticsView(database);
    if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
    const generation = view.resolveGeneration(config.source, config.generation);
    if (!generation.generation && generation.status === 'missing') {
      const body = output(config.format, generation, [], null, false);
      view.close();
      view = undefined;
      opened.close();
      opened = undefined;
      return { code: 2, stdout: '', stderr: body, openHandles: 0 };
    }
    if (config.record) {
      const records =
        generation.coverage === 'recorded'
          ? view.recordDetail({
              source: config.source,
              generation: generation.generation,
              recordKey: config.record,
              ...(config.phase ? { phase: config.phase } : {}),
            })
          : [];
      const body = output(config.format, generation, records, null, true);
      view.close();
      view = undefined;
      opened.close();
      opened = undefined;
      return { code: 0, stdout: body, stderr: '', openHandles: 0 };
    }
    let after: string | undefined;
    if (config.cursor) {
      after = decodeDiagnosticCursor(config.cursor, {
        source: config.source,
        generation: generation.generation,
        view: 'records',
        ...(config.phase ? { phase: config.phase } : {}),
      }).after;
    }
    const page: ConversionDiagnosticPage =
      generation.coverage === 'recorded'
        ? view.pageRecords({
            source: config.source,
            generation: generation.generation,
            limit: config.limit,
            ...(after ? { after } : {}),
            ...(config.phase ? { phase: config.phase } : {}),
          })
        : { generation, records: [], nextCursor: null };
    const body = output(config.format, page.generation, page.records, page.nextCursor, false);
    view.close();
    view = undefined;
    opened.close();
    opened = undefined;
    return { code: 0, stdout: body, stderr: '', openHandles: 0 };
  } catch (error) {
    if (view)
      try {
        view.close();
      } catch {
        // Preserve the original failure.
      }
    if (opened)
      try {
        opened.close();
      } catch {
        // Preserve the original failure.
      }
    const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    if (interrupted) return { code: 130, stdout: '', stderr: 'Diagnostics interrupted.\n', openHandles: 0 };
    if (error instanceof InputFailure || error instanceof ConversionDiagnosticError)
      return { code: 2, stdout: '', stderr: 'Invalid diagnostics arguments.\n', openHandles: 0 };
    return { code: 1, stdout: '', stderr: 'Diagnostics failed safely.\n', openHandles: 0 };
  }
}
