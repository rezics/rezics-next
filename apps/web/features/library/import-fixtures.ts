import type { ApplyIntent, ApplyProgress, ImportApi, ImportRow, RowResolution } from './import-api.ts';
import { ImportError } from './import-api.ts';

// An in-memory Main for stories and tests: it matches nothing itself, it only replays the outcomes a
// fixture states (matched, ambiguous, not found) and applies them in small steps, as Main does.

const work = (index: number) => `https://rezics.com/id/0194f314-9280-767f-89a6-${index.toString().padStart(12, '0')}`;
export const agentId = work(99);

type Source = ImportRow['source'];
export function source(title: string, creators: string[], over: Partial<Source> = {}): Source {
  return { kind: 'source', sourceId: title, title, creators, work: null, target: null, identifiers: [], status: 'read',
    startedOn: null, finishedOn: null, score: null, review: null, shelves: [], readCount: null, progress: null,
    session: null, raw: {}, ...over };
}
const candidate = (index: number, title: string, creators: string[]) => ({ work: work(index), target: null, title, creators });
const matched = (index: number, title: string, creators: string[]): NonNullable<ImportRow['match']> => ({ kind: 'matched',
  work: work(index), target: null, truncated: false, openLibraryAvailability: 'not-requested', candidates: [candidate(index, title, creators)],
  openLibrary: [] });

/** A Goodreads file as Main reports it: six matched rows, two ambiguous and one not found with an Open Library candidate. */
export function goodreadsRows(): ImportRow[] {
  const rows: Array<[Source, ImportRow['match']]> = [
    [source('Pride and Prejudice', ['Jane Austen'], { score: { value: 5, min: 1, max: 5, step: 1 }, shelves: ['classics'] }), matched(1, 'Pride and Prejudice', ['Jane Austen'])],
    [source('Jane Eyre', ['Charlotte Brontë']), matched(2, 'Jane Eyre', ['Charlotte Brontë'])],
    [source('Frankenstein', ['Mary Shelley'], { status: 'want-to-read' }), matched(3, 'Frankenstein', ['Mary Shelley'])],
    [source('Little Women', ['Louisa May Alcott'], { status: 'dnf' }), matched(4, 'Little Women', ['Louisa May Alcott'])],
    [source('雨夜书店', ['林雨'], { status: 'reading' }), matched(5, '雨夜书店', ['林雨'])],
    [source('Moby-Dick', ['Herman Melville'], { status: 'paused' }), matched(6, 'Moby-Dick', ['Herman Melville'])],
    [source('Ambiguous Tale', ['Alex Lee']), { kind: 'ambiguous', work: null, target: null, truncated: false, openLibraryAvailability: 'not-requested',
      candidates: [candidate(8, 'Ambiguous Tale', ['Alex Lee']), candidate(9, 'Ambiguous Tale', ['Alexandra Lee'])], openLibrary: [] }],
    [source('The Two Tales', ['Sam Park']), { kind: 'ambiguous', work: null, target: null, truncated: true, openLibraryAvailability: 'not-requested',
      candidates: Array.from({ length: 7 }, (_, at) => candidate(20 + at, 'The Two Tales', ['Sam Park'])), openLibrary: [] }],
    [source('Unknown Book', ['Nobody Real']), { kind: 'not-found', work: null, target: null, truncated: false, openLibraryAvailability: 'available',
      candidates: [], openLibrary: [{ workId: 'OL66554W', title: 'Unknown Book', authors: ['Nobody Real'], coverId: null }] }],
  ];
  return rows.map(([row, match], index) => ({ index, source: row, match, resolution: null, outcome: null, version: 1 }));
}

export interface FakeOptions {
  /** Rows applied per `apply` call; Main resumes at most eight. */
  step?: number;
  /** Fail the nth `apply` call (1-based) once, as a lost connection would. */
  failApplyAt?: number;
  /** Row indexes whose apply reports an issue. */
  issues?: Record<number, string[]>;
  /** The file's headers and distinct values for a CSV that needs mapping. */
  csv?: { headers: string[]; distinctValues: Record<string, string[]> };
  delayMs?: number;
  /** Row indexes another device changes just before this reader's first choice on them (a 409). */
  changedElsewhere?: number[];
}

export function fakeImportApi(rows: ImportRow[] = goodreadsRows(), options: FakeOptions = {}): ImportApi & { held: ImportRow[]; calls: string[] } {
  const { step = 3, issues = {}, delayMs = 0 } = options;
  let applies = 0, sealed: ApplyIntent | null = null;
  const changed = new Set(options.changedElsewhere ?? []);
  const calls: string[] = [];
  const wait = () => delayMs ? new Promise(resolve => setTimeout(resolve, delayMs)) : Promise.resolve();
  const progress = (): ApplyProgress => ({ total: rows.length, completed: rows.filter(row => row.outcome).length,
    issues: rows.filter(row => row.outcome?.issues.length).length, pending: rows.some(row => !row.outcome) });
  return {
    held: rows, calls,
    async inspect() { calls.push('inspect'); await wait(); return options.csv ?? { headers: ['Title', 'Author', 'Status', 'Progress', 'Translator'],
      distinctValues: { Title: [], Author: [], Status: ['Reading', 'Dropped', 'Completed'], Progress: ['c12'], Translator: ['Fan group'] } }; },
    async create() { calls.push('create'); await wait(); return { id: 'file-1', total: rows.length }; },
    async rows(_id, cursor) {
      await wait();
      const page = rows.filter(row => row.index > cursor).slice(0, 8);
      return { rows: page.map(row => ({ ...row })), nextCursor: page.length === 8 && page.at(-1)!.index < rows.length - 1 ? page.at(-1)!.index : null };
    },
    async resolve(_id, row, choice: RowResolution) {
      calls.push(`resolve:${row.index}:${choice.choice}`); await wait();
      if (sealed) throw new ImportError('conflict');
      const held = rows.find(item => item.index === row.index)!;
      if (changed.delete(row.index)) held.version += 1;
      if (held.version !== row.version) throw new ImportError('conflict');
      held.resolution = choice; held.version += 1;
    },
    async apply(_id, intent) {
      calls.push('apply'); await wait();
      applies += 1;
      if (options.failApplyAt === applies) throw new ImportError('unavailable');
      if (rows.some(row => !row.resolution && row.match?.kind !== 'matched')) throw new ImportError('conflict');
      sealed = intent;
      for (const row of rows.filter(item => !item.outcome).slice(0, step)) {
        const problems = issues[row.index] ?? [];
        row.outcome = { applied: row.resolution?.choice === 'private' || row.match?.kind === 'not-found' ? ['private-source'] : ['status', 'private-source'], issues: problems };
        row.version += 1;
      }
      return progress();
    },
    async discard() { calls.push('discard'); await wait(); rows.length = 0; },
    async adopt(_id, _row, workId) { calls.push(`adopt:${workId}`); await wait(); return work(500); },
  };
}

/** What Main holds after an apply that stopped half way: choices sealed, some rows done. */
export function halfApplied(): ImportRow[] {
  return goodreadsRows().map(row => ({ ...row,
    resolution: row.match?.kind === 'ambiguous' ? { choice: 'apply', work: row.match.candidates[0]!.work } : row.match?.kind === 'not-found' ? { choice: 'private' } : null,
    outcome: row.index < 4 ? { applied: ['status', 'private-source'], issues: [] } : null }));
}
