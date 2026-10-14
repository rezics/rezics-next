import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import bookRecord from '../../../../tests/qa/fixtures/outcomes/books/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import type { ReadingPositionItem, ReadingPositionPage } from '../wiki/position-picker.ts';
import type { WorkHeader } from '../work-page/types.ts';
import { mainMediaApi } from './media-api.ts';

const record = bookRecord as unknown as AnswerRecord;
export const chapterScenarioPersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type ChapterScenarioMedium = 'book' | 'manga';
export type ChapterScenarioState = 'populated' | 'loading' | 'empty' | 'error' | 'indexing';
const iri = (n: number) => `https://rezics.com/id/00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export function bookProgressSample(label: string): AnswerSample {
  const sample = record.personas.owner.find(item => item.label === label);
  if (!sample) throw new Error(`Missing recorded Book progress answer: ${label}`);
  return sample;
}
const bookHeader = bookProgressSample('book-type').answer as WorkHeader;
const bookTitle = bookHeader.title;
if (!bookTitle) throw new Error('Recorded Book header has no title');
const bookChoices = bookProgressSample('chapter-choices').answer as ReadingPositionPage;
const bookChapter = bookChoices.items[1]!;
const bookActor = (bookProgressSample('device-one-save').body as { actingSubject: string }).actingSubject;

/** Missing recordings are explicit contract fixtures, never relabelled as recorded answers. */
export function chapterScenarioIdentity(medium: ChapterScenarioMedium, persona: AnswerPersona) {
  return {
    work: medium === 'book' ? bookHeader.id : iri(100),
    omnibus: medium === 'book' ? null : iri(101),
    actingSubject: persona === 'visitor' ? undefined : medium === 'book' && persona === 'owner'
      ? bookActor : iri(10 + chapterScenarioPersonas.indexOf(persona)),
  };
}

function mangaChapter(volume: number, chapter: number): ReadingPositionItem {
  const structure = iri(200 + volume);
  return { work: iri(300 + volume), structure, revision: iri(400 + volume), occurrence: iri(500 + volume * 10 + chapter),
    parent: structure, segmentKey: `${volume}-${chapter}`, orderKey: `${volume}-${chapter}`, role: 'chapter',
    target: 'https://schema.org/DigitalDocument', labels: [{ value: `Volume ${volume}, chapter ${chapter}`, language: 'en' }],
    ordinal: chapter };
}
const mangaItems = [mangaChapter(1, 1), mangaChapter(1, 2), mangaChapter(2, 1), mangaChapter(2, 2)];
const sourcePosition = bookChoices.sourcePosition;

export interface ChapterScenarioRequest { device: 'first' | 'second'; method: string; path: string; body?: unknown; key?: string | null }

/**
 * Browser transport only. Book owner progress answers are replayed unchanged. Manga, public
 * contents and adverse states are built from the typed contract pending the prove-phase capture.
 * Each device is bound to its own grant of the same Person; roles never change that Person.
 */
export function createChapterScenario(medium: ChapterScenarioMedium, persona: AnswerPersona, state: ChapterScenarioState = 'populated') {
  const identity = chapterScenarioIdentity(medium, persona);
  const items = medium === 'book' ? bookChoices.items : mangaItems;
  const selected = medium === 'book' ? bookChapter : mangaItems[2]!;
  const progressPath = `/v1/compositions/${selected.structure.slice(-36)}/occurrences/${selected.occurrence.slice(-36)}/progress`;
  const header: WorkHeader = medium === 'book' ? bookHeader : { ...bookHeader, id: identity.work,
    revision: iri(102), mainVersion: iri(103), mainVersionRevision: iri(104),
    title: { ...bookTitle, value: 'Ink Garden Manga series' },
    types: ['https://schema.org/BookSeries'] };
  let version = medium === 'book' && persona === 'owner' ? 1 : 0;
  let completed = version === 1, position: string | null = null;
  let savedStatus: 'reading' | 'read' | 'want-to-read' | null = null, statusVersion = 0;
  let loseAnswer = medium === 'manga';
  const requests: ChapterScenarioRequest[] = [];
  const replayed = new Map<string, unknown>();
  const response = (answer: unknown, status = 200, headers?: HeadersInit) => Response.json(answer, { status, headers });
  const inventory = (work: string, resume: boolean, cursor: string | null): ReadingPositionPage => {
    const available = state === 'empty' || state === 'indexing' ? [] : items;
    const last = state === 'empty' || state === 'indexing' ? null : completed ? selected
      : medium === 'manga' ? mangaItems[1]! : version > 0 ? items[0]! : null;
    const page = resume && last ? [last] : medium === 'manga' ? available.slice(cursor ? 2 : 0, cursor ? 4 : 2) : available;
    const nextCursor = !(resume && last) && medium === 'manga' && available.length > 2 && !cursor ? 'volume-two' : null;
    return { profile: 'reading-positions-v1', work, resolved: resume && last ? last.occurrence : 'start', items: page,
      complete: state !== 'indexing' && nextCursor === null, scope: resume && last ? 'resume' : 'positions', visibility: page.length ? 'visible' : 'empty',
      ...(state === 'indexing' ? { search: { status: 'indexing' as const } } : {}),
      nextCursor, next: null, sourcePosition, count: { value: page.length, kind: state === 'indexing' ? 'at-least' : 'exact-page', total: null }, cost: bookChoices.cost };
  };
  const seed: ReaderSeed = { [identity.work]: { status: null, version: 0, rating: null } };
  const fetcherFor = (device: 'first' | 'second'): typeof fetch => Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    const path = url.pathname.replace(BFF_PREFIX, '');
    const body = request.method === 'GET' ? undefined : await request.json() as Record<string, unknown>;
    requests.push({ device, method: request.method, path: path + url.search, ...(body ? { body } : {}),
      key: request.headers.get('idempotency-key') });
    const subject = body?.actingSubject ?? url.searchParams.get('actingSubject') ?? undefined;
    if (subject !== identity.actingSubject) throw new Error(`Scenario supplied a foreign Person: ${String(subject)}`);
    if (path === `/v1/works/${identity.work.slice(-36)}`) return response(header);
    if (identity.omnibus && path === `/v1/works/${identity.omnibus.slice(-36)}`) return response({ ...header, id: identity.omnibus,
      title: { ...bookTitle, value: 'Ink Garden omnibus' } });
    if (path === `/v1/works/${identity.work.slice(-36)}/progress`
      || identity.omnibus && path === `/v1/works/${identity.omnibus.slice(-36)}/progress`) return response({ parts: true });
    if (path === '/v1/me/follow-state') return response({ target: identity.work, kind: 'work', following: false,
      level: null, source: null, pinPosition: null, revision: null });
    if (path.endsWith('/reader-status') && body) {
      savedStatus = body.status as typeof savedStatus;
      return response({ work: identity.work, status: savedStatus, version: ++statusVersion, replayed: false });
    }
    if (path.startsWith('/v1/reading-positions/')) {
      if (state === 'loading') return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
      if (state === 'error') return response({ code: 'progress_unavailable', title: 'Progress unavailable', detail: 'Try again' }, 503);
      if (state === 'populated' && medium === 'book' && persona === 'owner' && url.searchParams.get('position') === 'start') {
        const sample = bookProgressSample('chapter-choices');
        return response(sample.answer, sample.status, sample.headers);
      }
      if (state === 'populated' && medium === 'book' && persona === 'owner' && !completed) {
        const sample = bookProgressSample('chapter-resume');
        return response(sample.answer, sample.status, sample.headers);
      }
      const work = path.endsWith(identity.omnibus?.slice(-36) ?? '<none>') ? identity.omnibus! : identity.work;
      return response(inventory(work, url.searchParams.get('position') === 'mine', url.searchParams.get('cursor')));
    }
    const earlier = mangaItems[1]!;
    if (medium === 'manga' && request.method === 'GET'
      && path === `/v1/compositions/${earlier.structure.slice(-36)}/occurrences/${earlier.occurrence.slice(-36)}/progress`) {
      if (!identity.actingSubject) throw new Error('Visitor requested private progress');
      return response({ structure: earlier.structure, occurrence: earlier.occurrence, selectedRevision: null,
        completed: true, position: null, version: 1 });
    }
    if (path === progressPath) {
      if (!identity.actingSubject) throw new Error('Visitor requested private progress');
      if (request.method === 'GET') {
        if (medium === 'book' && persona === 'owner') {
          const sample = bookProgressSample(version === 1 ? 'device-two-before-save' : version === 2 ? 'device-two-conflict-current' : 'device-one-sees-recovery');
          return response(sample.answer, sample.status, sample.headers);
        }
        return response({ structure: selected.structure, occurrence: selected.occurrence, selectedRevision: null, completed, position, version });
      }
      const key = request.headers.get('idempotency-key')!;
      if (replayed.has(key)) return response({ ...replayed.get(key) as object, replayed: true });
      if (body!.expectedVersion !== version) {
        if (medium === 'book' && persona === 'owner') {
          const sample = bookProgressSample('device-two-stale-save-refused');
          return response(sample.answer, sample.status, sample.headers);
        }
        return response({ code: 'stale_progress', title: 'Progress changed' }, 409);
      }
      completed = body!.completed as boolean; position = body!.position as string | null; version++;
      const answer = medium === 'book' && persona === 'owner'
        ? bookProgressSample(completed ? 'device-one-save' : 'device-two-recovered-save').answer
        : { structure: selected.structure, occurrence: selected.occurrence, selectedRevision: null, completed, position, version, replayed: false };
      if (medium === 'book' && persona === 'owner') {
        const sample = bookProgressSample(completed ? 'device-one-save' : 'device-two-recovered-save');
        if (JSON.stringify(sample.body) !== JSON.stringify(body)) {
          // Request object order is not part of the protocol.
          const expected = sample.body as Record<string, unknown>;
          if (Object.keys(expected).some(name => expected[name] !== body![name])) throw new Error('Book story deviated from the recorded command');
        }
      }
      replayed.set(key, answer);
      if (loseAnswer) { loseAnswer = false; return response({ code: 'temporarily_unavailable' }, 503); }
      return response(answer);
    }
    throw new Error(`Unmatched chapter scenario request: ${request.method} ${path}`);
  }, { preconnect: fetch.preconnect });
  const client = (device: 'first' | 'second') => browserMainApi('https://recorded.invalid', {
    anonymous: persona === 'visitor', fetcher: fetcherFor(device) });
  const first = client('first'), second = client('second');
  return { ...identity, header, items, selected, seed, requests, first, second, progressPath,
    firstApi: identity.actingSubject ? mainMediaApi(identity.actingSubject, () => first) : null,
    secondApi: identity.actingSubject ? mainMediaApi(identity.actingSubject, () => second) : null,
    fetcher: fetcherFor('first'),
    inventory: () => inventory(identity.work, false, null),
  };
}

/** Exact requests/states that have no recorded answer; capture belongs to the prove phase. */
export function chapterProgressMissingStates(medium: ChapterScenarioMedium, persona: AnswerPersona) {
  const scenario = createChapterScenario(medium, persona);
  const actingSubject = scenario.actingSubject;
  const query = (position: string, cursor?: string) => new URLSearchParams({ position, limit: '20',
    ...(actingSubject ? { actingSubject } : {}), ...(cursor ? { cursor } : {}) }).toString();
  const resume = `/v1/reading-positions/${scenario.work.slice(-36)}?${query('mine')}`;
  const progressVersion = medium === 'book' && persona === 'owner' ? 1 : 0;
  const mark = (expectedVersion: number, completed: boolean, position: string | null) => ({ method: 'PUT', path: scenario.progressPath,
    body: { actingSubject, expectedVersion, completed, position } });
  return [
    { method: 'GET', path: `/v1/works/${scenario.work.slice(-36)}${actingSubject ? `?${new URLSearchParams({ actingSubject })}` : ''}`, states: ['populated: Work frame'] },
    { method: 'GET', path: `/v1/works/${scenario.work.slice(-36)}/agent-credits${actingSubject ? `?${new URLSearchParams({ actingSubject })}` : ''}`, states: ['populated: native author credit from original-contribution fixture owner'] },
    { method: 'GET', path: resume, states: ['loading', 'populated', 'empty: HTTP 200 items=[] complete=true',
      'indexing: HTTP 200 items=[] complete=false nextCursor=null count.kind=at-least', 'error: HTTP 503'] },
    { method: 'GET', path: `/v1/reading-positions/${scenario.work.slice(-36)}?${query('start')}`, states: ['populated'] },
    ...(medium === 'manga' ? [{ method: 'GET', path: `/v1/reading-positions/${scenario.work.slice(-36)}?${query('start', 'volume-two')}`, states: ['populated: second volume'] },
      { method: 'GET', path: `/v1/works/${scenario.omnibus!.slice(-36)}${actingSubject ? `?${new URLSearchParams({ actingSubject })}` : ''}`, states: ['populated: omnibus Work frame'] },
      ...(actingSubject ? [
        { method: 'GET', path: `/v1/compositions/${mangaItems[1]!.structure.slice(-36)}/occurrences/${mangaItems[1]!.occurrence.slice(-36)}/progress?${new URLSearchParams({ actingSubject })}`, states: ['populated: earlier Volume 1 chapter 2 completed=true version=1'] },
        { method: 'GET', path: `/v1/reading-positions/${scenario.omnibus!.slice(-36)}?${query('mine')}`, states: ['populated: same saved chapter'] },
      ] : []),
    ] : []),
    ...(actingSubject ? [
      { method: 'GET', path: `/v1/me/follow-state?${new URLSearchParams({ actingSubject, target: scenario.work, kind: 'work' })}`, states: ['populated: following=false'] },
      { method: 'PUT', path: `/v1/works/${scenario.work.slice(-36)}/reader-status`, body: { actingSubject, expectedVersion: 0, status: 'reading' }, states: ['populated: own shelf status'] },
      { method: 'GET', path: `/v1/works/${scenario.work.slice(-36)}/progress?${new URLSearchParams({ actingSubject })}`, states: ['populated: parts=true'] },
      { method: 'GET', path: `${scenario.progressPath}?${new URLSearchParams({ actingSubject })}`, states: [`populated: versions ${progressVersion}, ${progressVersion + 1}, ${progressVersion + 2}`] },
      { ...mark(progressVersion, true, medium === 'book' ? 'device one paragraph' : null), states: ['populated: winning save', 'replay: same key after lost response'] },
      { ...mark(progressVersion, medium !== 'book', null), states: ['error: stale_progress HTTP 409'] },
      { ...mark(progressVersion + 1, false, null), states: ['populated: recovered undo'] },
    ] : []),
  ];
}
