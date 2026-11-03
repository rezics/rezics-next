import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential, sessionSubject } from '../../session/request';
import type { Release } from '../../subject/definitions';
import { libraryFullQuery, libraryListQuery, readLibraryResult } from '../reads';
import type { CopyItem, CopiesPageData } from '../copies-read';
import { loadCopiesPage } from '../copies-read';
import { copiesSubjectId } from '../copies-query';
import { nativeProgressPresentation, type ProgressMode, type ProgressSessionCore } from '../progress-reads';
import { libraryChoices, libraryStateLabel, type LibraryChoices } from '../profiles';
import { m } from '../../paraglide/messages.js';
import {
  entryMeaning,
  readConfiguredProfileCapabilities,
  type ConfiguredProfileCapabilities,
  type MangaLibraryIdentity,
} from './capabilities';
import { emptyVisitWork, finishVisitWork, observeLibraryWork, type VisitWork } from './cost';
import type { CopyProfile } from '../copies-profiles';
import type { ManualProgressMeasure } from '../profiles';
import type { ProgressInputRules } from '../progress-profile';

export type VisitEntry =
  | { meaning: 'absent' }
  | {
      meaning: 'current' | 'historical';
      subjectId: string;
      state: string;
      label: string;
      revision: number;
      incarnationId?: string | null;
    };

export type VisitProgressSession = {
  id: string;
  revision: number;
  amount: string | null;
  total: string | null;
  unit: string;
  mode: ProgressMode;
  state: ProgressSessionCore['state'];
  meaning: 'known' | 'unknown' | 'unavailable';
  recordingState: 'supported' | 'unsupported' | 'unavailable';
  unitLabel?: string;
};

export type VisitProgress =
  | { meaning: 'unsupported' }
  | {
      meaning: 'absent';
      measure: ManualProgressMeasure;
      rules: ProgressInputRules;
      session?: VisitProgressSession;
    }
  | {
      meaning: 'zero' | 'recorded' | 'historical';
      measure: ManualProgressMeasure;
      rules: ProgressInputRules;
      session: VisitProgressSession;
    };

export type VisitCopies = {
  items: CopyItem[];
  next: string | null;
  addKey: string;
  sendKind: boolean;
  profile: CopyProfile;
  requestedCursor: string | null;
  cursorRestarted?: boolean;
};

export type ConfiguredLibraryVisit =
  | { state: 'signed-out'; work: VisitWork }
  | { state: 'refused'; work: VisitWork }
  | { state: 'unavailable'; work: VisitWork; closed?: boolean }
  | {
      state: 'unsupported';
      identity: MangaLibraryIdentity | null;
      work: VisitWork;
      viewer: string;
      csrfToken: string | null;
    }
  | {
      state: 'ready';
      identity: MangaLibraryIdentity | null;
      capabilities: Extract<ConfiguredProfileCapabilities, { state: 'ready' }>;
      entry: VisitEntry;
      progress: VisitProgress;
      copies: VisitCopies;
      viewer: string;
      csrfToken: string | null;
      work: VisitWork;
    };

export type ConfiguredVisitInput = {
  subjectId: string;
  type: string;
  locale: string;
  copyCursor?: string;
  sessionCursor?: string;
};

function problemBody(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return 'value' in error ? (error as { value: unknown }).value : error;
}

function presentEntry(
  release: Release,
  type: string,
  locale: string,
  choices: LibraryChoices | undefined,
  row: { subjectId: string; state: string; revision: number; incarnationId?: string | null } | null,
): VisitEntry {
  if (!row) return { meaning: 'absent' };
  const meaning = entryMeaning(choices, row.state);
  return {
    meaning: meaning === 'absent' ? 'current' : meaning,
    subjectId: row.subjectId,
    state: row.state,
    label: libraryStateLabel(release, type, row.state, locale)?.text ?? m.library_other(),
    revision: row.revision,
    ...(row.incarnationId === undefined ? {} : { incarnationId: row.incarnationId }),
  };
}

function presentProgress(
  capabilities: Extract<ConfiguredProfileCapabilities, { state: 'ready' }>,
  sessions: VisitProgressSession[],
): VisitProgress {
  const measure = capabilities.measure;
  if (!measure) return { meaning: 'unsupported' };
  const session = sessions.find((item) => item.mode === measure.mode && item.unit === measure.unit.id);
  if (!session) return { meaning: 'absent', measure, rules: capabilities.measureRules };
  if (session.meaning !== 'known') return { meaning: 'historical', measure, rules: capabilities.measureRules, session };
  if (session.amount === null) return { meaning: 'absent', measure, rules: capabilities.measureRules, session };
  return {
    meaning: session.amount === '0' ? 'zero' : 'recorded',
    measure,
    rules: capabilities.measureRules,
    session,
  };
}

async function readEntry(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<
  | { status: 'absent' }
  | { status: 'refused' }
  | { status: 'ok'; entry: { subjectId: string; state: string; revision: number; incarnationId?: string | null } }
> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  const body = problemBody(result.error);
  if (isPlatformClosedProblem(result.status, body)) throw Object.assign(new Error('closed'), { closed: true });
  if (result.status === 404) return { status: 'absent' };
  if (result.status === 401 || result.status === 403) return { status: 'refused' };
  if (result.error || !result.data || !('libraryEntry' in result.data)) return { status: 'absent' };
  const entry = (
    result.data as {
      libraryEntry: { subjectId: string; state: string; revision: number; incarnationId?: string | null };
    }
  ).libraryEntry;
  if (!entry || entry.subjectId !== subjectId) return { status: 'absent' };
  return { status: 'ok', entry };
}

type RawSession = {
  id: string;
  subjectId: string;
  mode: ProgressMode;
  unit: string;
  amount: string | null;
  total: string | null;
  state: ProgressSessionCore['state'];
  revision: number;
  presentation?: unknown;
};

function presentSession(raw: RawSession): VisitProgressSession {
  const presentation = nativeProgressPresentation(raw as never);
  return {
    id: raw.id,
    revision: raw.revision,
    amount: raw.amount,
    total: raw.total,
    unit: raw.unit,
    mode: raw.mode,
    state: raw.state,
    meaning: presentation?.meaning ?? 'unavailable',
    recordingState: presentation?.recording.state ?? 'unavailable',
    ...(presentation?.unitLabel === undefined ? {} : { unitLabel: presentation.unitLabel }),
  };
}

async function readSessions(
  client: KernelClient,
  subjectId: string,
  authorization: string,
  cursor?: string,
): Promise<{ sessions: VisitProgressSession[]; next: string | null }> {
  const result = await client.progressSessions.get({
    query: { ...libraryListQuery(cursor), subjectId },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  const body = problemBody(result.error);
  if (isPlatformClosedProblem(result.status, body)) throw Object.assign(new Error('closed'), { closed: true });
  if (result.status === 401 || result.status === 403) throw Object.assign(new Error('refused'), { refused: true });
  const page = readLibraryResult<{ progressSessions: RawSession[]; next: string | null }>(result as never);
  return {
    sessions: page.progressSessions.filter((session) => session.subjectId === subjectId).map(presentSession),
    next: page.next,
  };
}

function copiesFromPage(page: CopiesPageData, profile: CopyProfile): VisitCopies {
  return {
    items: page.copies,
    next: page.next,
    addKey: page.addKey,
    sendKind: page.sendKind ?? true,
    profile,
    requestedCursor: page.requestedCursor ?? null,
    ...(page.cursorRestarted ? { cursorRestarted: true } : {}),
  };
}

/**
 * One exact series/volume visit: current profile, addressed entry, one sessions page and one copies page.
 * Unrelated owner rows are never listed; work is the recorded native calls and the projected page.
 */
export async function loadConfiguredLibraryVisit(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: ConfiguredVisitInput,
  release: Release | undefined,
): Promise<ConfiguredLibraryVisit> {
  const calls: string[] = [];
  const observed = observeLibraryWork(client, (name) => {
    calls.push(name);
  });
  const capabilities = readConfiguredProfileCapabilities(release, input.type, input.locale);
  const workFor = (projection: unknown, rows = 0) =>
    finishVisitWork(calls, capabilities.state === 'ready' ? capabilities.admittedFields : 0, rows, projection);

  if (await prepareSession(request, sessionEnv)) return { state: 'refused', work: emptyVisitWork() };
  const authorization = viewerCredential(request);
  const viewer = sessionSubject(request);
  if (!authorization || !viewer) return { state: 'signed-out', work: emptyVisitWork() };
  const csrfToken = request.headers.get('x-csrf-token');
  const subjectId = copiesSubjectId(input.subjectId);
  if (!subjectId) return { state: 'unavailable', work: emptyVisitWork() };

  if (capabilities.state === 'unavailable') return { state: 'unavailable', work: workFor({ viewer }) };
  if (capabilities.state === 'unsupported') {
    return {
      state: 'unsupported',
      identity: capabilities.identity,
      work: workFor({ viewer, identity: capabilities.identity }),
      viewer,
      csrfToken,
    };
  }

  try {
    const [entryResult, copiesPage, sessionsPage] = await Promise.all([
      readEntry(observed, subjectId, authorization),
      loadCopiesPage(observed, request, sessionEnv, {
        subjectId,
        ...(input.copyCursor ? { cursor: input.copyCursor } : {}),
      }),
      readSessions(observed, subjectId, authorization, input.sessionCursor),
    ]);
    if (entryResult.status === 'refused') return { state: 'refused', work: workFor({ viewer }) };
    const choices = release ? libraryChoices(release, input.type) : undefined;
    const entry = presentEntry(
      release!,
      input.type,
      input.locale,
      choices,
      entryResult.status === 'ok' ? entryResult.entry : null,
    );
    const progress = presentProgress(capabilities, sessionsPage.sessions);
    const copies = copiesFromPage(copiesPage, capabilities.copies);
    const projection = {
      identity: capabilities.identity,
      entry,
      progress: {
        meaning: progress.meaning,
        ...(progress.meaning === 'unsupported' ? {} : { unit: progress.measure.unit.id }),
        ...('session' in progress ? { sessionId: progress.session.id, amount: progress.session.amount } : {}),
      },
      copies: copies.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        revision: item.revision,
      })),
      copiesNext: copies.next,
      sessionsNext: sessionsPage.next,
    };
    const pageRows = copies.items.length + sessionsPage.sessions.length + (entry.meaning === 'absent' ? 0 : 1);
    return {
      state: 'ready',
      identity: capabilities.identity,
      capabilities,
      entry,
      progress,
      copies,
      viewer,
      csrfToken,
      work: workFor(projection, pageRows),
    };
  } catch (error) {
    if ((error as { refused?: boolean }).refused) return { state: 'refused', work: workFor({ viewer }) };
    if ((error as { closed?: boolean }).closed || isPlatformClosedError(error))
      return { state: 'unavailable', work: workFor({ viewer }), closed: true };
    return { state: 'unavailable', work: workFor({ viewer }) };
  }
}
