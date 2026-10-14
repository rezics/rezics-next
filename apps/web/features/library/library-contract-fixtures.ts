import type { AnswerCall, AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/collection-tracking-and-progress.json';
import recipes from '../../../../tests/qa/fixtures/outcomes/recipes/collection-tracking-and-progress.json';
import games from '../../../../tests/qa/fixtures/outcomes/games/collection-tracking-and-progress.json';
import novels from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import novelDevices from '../../../../tests/qa/fixtures/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.json';
import bookImport from '../../../../tests/qa/fixtures/outcomes/books/library-import.json';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { WorkStanding } from '../tracking/media-api.ts';
import type { MyShelves, ReaderStateItem, ShelfStatus, StatusShelfItem } from './types.ts';
import { parseLibraryState } from './state.ts';
import type { ApplyProgress, ImportRow } from './import-api.ts';
import { fakeExportApi } from '../library-backup/export-fixtures.ts';
import { ExportError } from '../library-backup/export-api.ts';

export type LibraryMedium = 'books' | 'recipes' | 'games' | 'visual-novels';
export type LibraryContractState = 'populated' | 'empty' | 'error' | 'loading' | 'stale' | 'replay' | 'pending'
  | 'export-interrupted' | 'export-moved';
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Header = Ok<ReturnType<MainClient['v1']['works']>['get']>;

const records: Record<LibraryMedium, AnswerRecord> = { books: books as AnswerRecord, recipes: recipes as AnswerRecord,
  games: games as AnswerRecord, 'visual-novels': novels as AnswerRecord };
const people: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];

/** These are constructed contract states, not new recordings. Every served request is available for prove. */
export function libraryContractFixture(medium: LibraryMedium, state: LibraryContractState = 'populated',
  persona: AnswerPersona = 'member') {
  const record = records[medium];
  const sourcePersona = medium === 'recipes' || medium === 'books' ? 'owner' : 'member';
  const samples = [...record.personas[sourcePersona],
    ...(medium === 'visual-novels' ? (novelDevices as AnswerRecord).personas.member : [])];
  const sample = (label: string) => {
    const found = samples.find(item => item.label === label);
    if (!found) throw new Error(`Missing source answer ${medium}/${label}`);
    return structuredClone(found.answer);
  };
  const actor = `https://rezics.com/id/00000000-0000-4000-8000-${String(people.indexOf(persona) + 1).padStart(12, '0')}`;
  const directoryLabel = medium === 'recipes' ? 'shelves' : medium === 'books' ? 'shelf-directory'
    : medium === 'games' ? 'library-overview' : 'library-reading-overview';
  const directory = sample(directoryLabel) as MyShelves;
  const headerAnswers = samples.filter(item => item.method === 'GET' && item.status === 200
    && /^\/v1\/works\/[0-9a-f-]{36}(?:\?|$)/u.test(item.path)).map(item => item.answer as Header);
  const headers = new Map(headerAnswers.map(item => [item.id, item]));
  const workStates = samples.flatMap(item => item.method !== 'GET' || item.status !== 200 ? []
    : item.path.includes('/reader-state') ? [item.answer as ReaderStateItem]
      : item.path.includes('/work-states') ? (item.answer as { items: ReaderStateItem[] }).items : []);
  const works = medium === 'books'
    ? (sample('currently-reading-preview') as { items: StatusShelfItem[] }).items
    : medium === 'games'
      ? [sample('game-header'), sample('composed-header')].map(value => {
        const header = value as Header;
        return { work: header.id, status: 'want-to-read', version: 1, startedOn: null, finishedOn: null,
          changedAt: null, card: { id: header.id, title: header.title, cover: header.cover, types: header.types } } satisfies StatusShelfItem;
      })
      : medium === 'visual-novels'
        ? (sample('library-reading-reading-preview') as { items: StatusShelfItem[] }).items
        : [{ work: (sample('library-work-header') as Header).id, status: null, version: 0 }];
  const entries = works.map(item => {
    const original = workStates.find(entry => entry.work === item.work);
    if (!original) throw new Error(`Missing source reader state for ${item.work}`);
    return { ...structuredClone(original), status: { ...original.status, status: item.status,
      version: item.version, startedOn: null, finishedOn: null }, rating: { global: null, realm: null }, progress: null };
  });
  directory.statusShelves = directory.statusShelves.map(shelf => ({ ...shelf, count: state === 'empty' ? 0
    : entries.filter(entry => entry.status.status === shelf.status).length }));
  if (state === 'empty') directory.items = [];
  if (medium !== 'recipes') directory.items = [];
  const recipeCollection = medium === 'recipes' ? sample('private-collection') as {
    collection: string; revision: string; occurrences: { occurrence: string; target?: string; state: string }[];
  } : null;
  const pageState = parseLibraryState(medium === 'recipes' && state !== 'empty'
    ? { shelf: recipeCollection!.collection.slice(-36) }
    : state === 'empty' ? {} : { shelf: medium === 'games' ? 'want-to-read' : 'reading' });
  const calls: (AnswerCall & { state: string; responseStatus?: number })[] = [];
  const importId = '00000000-0000-4000-8000-000000000030';
  const imported = (bookImport as AnswerRecord).personas.owner.find(item => item.label === 'production-import-review')!;
  const importRow = { ...structuredClone((imported.answer as { rows: ImportRow[] }).rows[0]!), outcome: null };
  const pending: ApplyProgress = { total: 1, completed: 0, issues: 0, pending: true, state: 'pending', reason: null };
  let exported = fakeExportApi(43, { failAt: state === 'export-interrupted' ? 20 : undefined,
    moved: state === 'export-moved' }).api;
  const marks = new Map(entries.map(entry => [entry.work, { standing: 'not-started' as WorkStanding, version: 0 }]));
  let conflict = state === 'stale';
  const partMarks = new Map<string, { completed: boolean; position: string | null; version: number }>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(BFF_PREFIX, '');
    const text = await request.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    const call = { operationId: 'contract-story-state', method: request.method, path: path + url.search,
      ...(body ? { body } : {}), state, responseStatus: undefined as number | undefined };
    calls.push(call);
    const reply = (answer: unknown, status = 200) => {
      call.responseStatus = status;
      return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
    };
    const subject = body?.actingSubject ?? url.searchParams.get('actingSubject');
    if (subject && subject !== actor) return reply({ code: 'acting_subject_denied' }, 403);
    if (persona === 'visitor' && (subject || request.method !== 'GET')) return reply({ code: 'authentication_required' }, 401);
    if (state === 'loading' && path === '/v1/me/shelves') return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
    if (state === 'error' && path === '/v1/me/shelves') return reply({ code: 'unavailable' }, 503);
    if (path === '/v1/me/shelves') return reply(directory);
    if (path.endsWith('/library-visibility')) return reply({ visibility: 'private', version: 0, changedAt: null });
    if (path === '/v1/rating-contexts') return reply(sample(medium === 'recipes' ? 'library-rating-contexts'
      : medium === 'books' ? 'global-rating-context' : medium === 'games' ? 'library-rating-context' : 'library-reading-rating-context'));
    if (path === '/v1/me/reading-goal') return reply({ year: 2026, target: null, completed: 0, version: 0, changedAt: null });
    if (path === '/v1/me/reading-stats') return reply(sample(medium === 'recipes' ? 'library-reading-stats'
      : medium === 'books' ? 'chapter-reading-stats' : medium === 'games' ? 'reading-year' : 'library-empty-reading-stats'));
    if (path === '/v1/me/follows/authors') return reply(sample(medium === 'recipes' ? 'library-followed-authors-empty'
      : medium === 'books' ? 'followed-authors' : medium === 'games' ? 'followed-authors' : 'library-empty-followed-authors'));
    if (path === '/v1/me/work-states') {
      const selected = new Set(url.searchParams.get('works')?.split(','));
      return reply({ profile: 'reader-work-states-v1', items: entries.filter(entry => selected.has(entry.work)),
        sourcePosition: directory.sourcePosition });
    }
    if (path === '/v1/me/import-reviews') return reply({ items: [] });
    if (path === `/v1/me/library-imports/${importId}/rows`) return reply({ rows: [importRow], nextCursor: null });
    if (path === `/v1/me/library-imports/${importId}/apply`) return reply(pending, request.method === 'POST' ? 202 : 200);
    if (path === '/v1/me/library-export') {
      try { return reply(await exported.page({ cursor: url.searchParams.get('cursor') ?? undefined,
        snapshot: url.searchParams.get('snapshot') ?? undefined })); }
      catch (failure) {
        if (failure instanceof ExportError && failure.failure === 'moved') {
          exported = fakeExportApi(43, { snapshot: 'snapshot-2' }).api;
          return reply({ code: 'library_export_basis_changed' }, 409);
        }
        return reply({ code: 'unavailable' }, 503);
      }
    }
    const status = path.match(/^\/v1\/me\/shelves\/status\/([^/]+)\/works$/u)?.[1] as ShelfStatus | undefined;
    if (status) return reply({ profile: 'reader-status-shelf-v1', status,
      items: state === 'empty' ? [] : works.filter(item => item.status === status), nextCursor: null,
      sourcePosition: directory.sourcePosition, count: { value: works.length, kind: 'exact-page', total: null } });
    if (path.startsWith('/v1/collections/') && recipeCollection) {
      if (request.method === 'POST') {
        const operations = body?.operations as { occurrence: string }[];
        recipeCollection.occurrences = recipeCollection.occurrences.filter(item => !operations.some(op => op.occurrence === item.occurrence));
        return reply(recipeCollection);
      }
      return reply(recipeCollection);
    }
    const id = path.match(/^\/v1\/works\/([0-9a-f-]{36})/u)?.[1];
    const work = id ? `https://rezics.com/id/${id}` : null;
    if (work && path === `/v1/works/${id}`) return reply(headers.get(work));
    if (work && path.endsWith('/reader-state')) return reply(entries.find(entry => entry.work === work));
    if (work && path.endsWith('/reader-status') && body) {
      const entry = entries.find(entry => entry.work === work)!;
      entry.status = { ...entry.status, status: body.status as ShelfStatus | null, version: entry.status.version + 1 };
      return reply(entry.status);
    }
    if (work && path.endsWith('/progress')) {
      const composed = medium === 'games' && work === (sample('composed-header') as Header).id;
      if (composed) return reply({ work, parts: true });
      const mark = marks.get(work)!;
      if (request.method === 'PUT' && body) {
        if (conflict) {
          conflict = false;
          marks.set(work, { standing: 'started', version: mark.version + 1 });
          return reply({ code: 'stale_progress' }, 409);
        }
        const saved = { standing: body.standing as WorkStanding, version: mark.version + 1 };
        marks.set(work, saved);
        return reply({ work, ...saved, replayed: state === 'replay' });
      }
      return reply({ work, parts: false, ...mark });
    }
    if (path.startsWith('/v1/resources/') && path.endsWith('/parts')) {
      if (medium === 'games' && path.includes((sample('composed-header') as Header).id.slice(-36))) return reply(sample('game-parts'));
      return reply({ code: 'not_found' }, 404);
    }
    if (/^\/v1\/compositions\/[0-9a-f-]{36}\/progress$/u.test(path)) {
      return reply({ items: [...partMarks].filter(([, mark]) => mark.completed).map(([occurrence]) => ({ occurrence })),
        nextCursor: null, complete: true });
    }
    if (path.startsWith('/v1/compositions/') && path.includes('/occurrences/')) {
      const occurrence = path.split('/occurrences/')[1]!.split('/')[0]!;
      const mark = partMarks.get(occurrence) ?? { completed: false, position: null, version: 0 };
      if (request.method === 'PUT' && body) {
        const saved = { completed: body.completed === true, position: body.position as string | null, version: mark.version + 1 };
        partMarks.set(occurrence, saved);
        return reply({ occurrence, ...saved });
      }
      return reply({ occurrence, ...mark });
    }
    if (path.startsWith('/v1/me/continue/')) {
      const source = samples.find(item => item.method === 'GET' && item.path.split('?')[0] === path && item.status === 200);
      if (source) return reply(source.answer);
    }
    throw new Error(`Missing contract story state: ${request.method} ${path}${url.search}`);
  }) as typeof fetch;
  const main = browserMainApi('https://library-contract.invalid', { fetcher });
  return { actor, main, reader: persona === 'visitor' ? null : { main, anonymous: main, actingSubject: actor },
    state: pageState, calls, entries, marks, recipeCollection, works, headers, importId };
}
