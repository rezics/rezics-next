import { ExportError, type ExportApi, type ExportPage, type ExportRow } from './export-api.ts';

// An in-memory Main export for stories and tests: pages of fixture rows with a snapshot token and a
// cursor, which can fail once at a page (a lost connection) or answer that the library changed.

const work = (index: number) => `https://rezics.com/id/0194f314-9280-767f-89a6-${index.toString().padStart(12, '0')}`;

export function exportRow(index: number): ExportRow {
  return { kind: 'entry', sourceId: `status:${work(index)}`, title: '', creators: [], work: work(index), target: null,
    identifiers: [], status: index % 3 ? 'read' : 'reading', startedOn: null, finishedOn: null, score: null, review: null,
    shelves: [], readCount: null, progress: null, session: null, raw: {} };
}

export interface FakeExport { api: ExportApi; calls: Array<{ cursor?: string; snapshot?: string }> }

export function fakeExportApi(total: number, options: { page?: number; failAt?: number; moved?: boolean; delayMs?: number } = {}): FakeExport {
  const { page = 20, delayMs = 0 } = options;
  const calls: FakeExport['calls'] = [];
  let failed = false;
  return { calls, api: { async page(position) {
    calls.push(position);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const from = position.cursor ? Number(position.cursor.slice('cursor-'.length)) : 0;
    if (options.moved && position.cursor) throw new ExportError('moved');
    if (options.failAt === from && !failed) { failed = true; throw new ExportError('unavailable'); }
    const rows = Array.from({ length: Math.max(0, Math.min(page, total - from)) }, (_, at) => exportRow(from + at));
    return { profile: 'rezics-library-export-v1', rows, snapshot: 'snapshot-1',
      nextCursor: from + page < total ? `cursor-${from + page}` : null } satisfies ExportPage;
  } } };
}
