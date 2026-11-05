import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import sessionsRecording from '../recorded/library-progress-sessions.json';
import changesRecording from '../recorded/library-progress-changes.json';
import sessionRecording from '../recorded/library-progress-session.json';
import logsRecording from '../recorded/library-published-logs.json';
import { storyViewerId } from './identities';
import { profileSession, profileSessionId } from './progress-profiles';

export type LibraryProgressStoryMode =
  | 'recorded'
  | 'none'
  | 'long'
  | 'constructed-unknown-identity'
  | 'unavailable'
  | 'error'
  | 'detail-empty'
  | 'detail-long'
  | 'original-history'
  | 'detail-original';

export const originalHistoryCursors = {
  changes: 'changes/+?q=原文#一% &==',
  units: 'units/+?q=原文#二% &==',
  logs: 'logs/+?q=原文#三% &==',
};
export const originalHistoryNextCursors = {
  changes: 'continued/changes+?= &',
  units: 'continued/units+?= &',
};
export const originalHistoryStaleCursors = {
  changes: 'stale/changes+?= &',
  units: 'stale/units+?= &',
};
export const originalHistorySessionId = sessionRecording.progressSession.id;
export const originalHistoryUnit = `historic-unit-${'unbroken-original-key-'.repeat(5)}`;

export const libraryProgressOriginalHistory = {
  locator: `  epubcfi(/6/2[${'original chapter annotation '.repeat(7)}])  `,
  unit: ` historic-cursor-unit-${'unresolved original unit '.repeat(5)} `,
} as const;

const originalCursorSession = {
  ...profileSession,
  mode: 'cursor_position',
  unit: libraryProgressOriginalHistory.unit,
  amount: null,
  total: null,
  locator: libraryProgressOriginalHistory.locator,
  position: '0.000000',
  state: 'completed',
  revision: 4,
  completedAt: '2026-10-30T00:00:00.000Z',
  presentation: {
    meaning: 'unknown',
    unitLabelLanguage: 'en',
    structure: 'unverified',
    recording: { state: 'unavailable' },
  },
};

function staleCursor(): KernelRecording {
  return { status: 409, code: 'stale_cursor' };
}

function originalCursorChange(id: string, revision: number, createdAt: string) {
  return {
    id,
    revision,
    createdAt,
    intent: { locator: libraryProgressOriginalHistory.locator, position: '0.000000' },
  };
}

const originalCursorChanges = [
  originalCursorChange(`${profileSessionId}:2`, 2, '2026-10-29T00:00:00.001Z'),
  originalCursorChange(`${profileSessionId}:3`, 3, '2026-10-29T00:00:00.002Z'),
  {
    id: `${profileSessionId}:4`,
    revision: 4,
    createdAt: '2026-10-30T00:00:00.000Z',
    intent: { action: 'complete' },
  },
];

export const libraryProgressStoryRequestCursor = 'earlier/opaque+==';
export const libraryProgressStoryNextCursor = 'next/opaque+==';

export const libraryProgressStoryLongSubjectLabel = (() => {
  const subject = sessionsRecording.progressSessions[0]?.subject;
  if (!subject) return null;
  const label = subject.label;
  return `${label} — ${label} — ${label} — ${label}`;
})();

let mode: LibraryProgressStoryMode = 'recorded';

export function setLibraryProgressStoryMode(next: LibraryProgressStoryMode): void {
  mode = next;
}

function failed(code: 'unavailable' | 'internal_error'): KernelRecording {
  return {
    status: code === 'unavailable' ? 503 : 500,
    type: `https://rezics.com/problems/${code}`,
    code,
  };
}

function constructedUnknownIdentityList(): KernelRecording {
  const progressSessions = sessionsRecording.progressSessions.map((session, index) => {
    const { unitLabel: _unitLabel, ...stored } = session as typeof session & { unitLabel?: string };
    if (!stored.subject || index !== 0 || !libraryProgressStoryLongSubjectLabel) return stored;
    return {
      ...stored,
      subject: { ...stored.subject, label: libraryProgressStoryLongSubjectLabel },
    };
  });
  return { status: 200, progressSessions, next: libraryProgressStoryNextCursor };
}

function list(): KernelRecording | undefined {
  if (mode === 'unavailable') return failed('unavailable');
  if (mode === 'error') return failed('internal_error');
  if (mode === 'none') return { status: 200, progressSessions: [], next: null };
  if (mode === 'constructed-unknown-identity') return constructedUnknownIdentityList();
  if (mode !== 'long') return undefined;
  const template = sessionsRecording.progressSessions[0];
  if (!template) return { status: 200, progressSessions: [], next: null };
  const progressSessions = Array.from({ length: 12 }, (_, index) => ({
    ...template,
    id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
    subjectId: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 101).padStart(12, '0')}`,
    subject: {
      ...template.subject,
      id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 101).padStart(12, '0')}`,
      label: `Progress story ${index + 1}`,
    },
  }));
  return { status: 200, progressSessions, next: null };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: () => list(),
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)$/,
    story: ({ match }) => {
      if (mode === 'unavailable') return failed('unavailable');
      if (mode === 'error') return failed('internal_error');
      if (mode === 'original-history' && match?.[1] === originalHistorySessionId)
        return {
          status: 200,
          progressSession: {
            ...sessionRecording.progressSession,
            mode: 'completed_units',
            unit: 'historic-unit-x',
            locator: null,
            position: null,
            completedUnitCount: 3,
            revision: 13,
            presentation: { meaning: 'unknown', structure: 'unverified', recording: { state: 'unavailable' } },
          },
        };
      if (mode === 'detail-original' && match?.[1] === profileSessionId)
        return { status: 200, progressSession: originalCursorSession };
      return undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/changes$/,
    story: ({ match, request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (mode === 'original-history' && match?.[1] === originalHistorySessionId) {
        if (cursor === originalHistoryStaleCursors.changes) return staleCursor();
        if (cursor === originalHistoryCursors.changes)
          return { status: 200, changes: [], next: originalHistoryNextCursors.changes };
        if (cursor === null)
          return {
            status: 200,
            changes: Array.from({ length: 12 }, (_, index) => ({
              ...changesRecording.changes[0],
              id: `${originalHistorySessionId}:${index + 2}`,
              revision: index + 2,
              intent: { add: [index < 2 ? originalHistoryUnit : `original-${index}`] },
            })),
            next: originalHistoryCursors.changes,
          };
      }
      if (mode === 'detail-original' && match?.[1] === profileSessionId && cursor === null)
        return { status: 200, changes: originalCursorChanges, next: null };
      if (mode === 'detail-empty') return { status: 200, changes: [], next: null };
      if (mode !== 'detail-long') return undefined;
      const template = changesRecording.changes[0];
      if (!template) return { status: 200, changes: [], next: null };
      return {
        status: 200,
        changes: Array.from({ length: 12 }, (_, index) => ({
          ...template,
          id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 201).padStart(12, '0')}`,
          intent: { ...template.intent, locator: `Progress story change ${index + 1}` },
        })),
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/completedUnits$/,
    story: ({ match, request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (mode === 'original-history' && match?.[1] === originalHistorySessionId) {
        if (cursor === originalHistoryStaleCursors.units) return staleCursor();
        if (cursor === originalHistoryCursors.units)
          return { status: 200, completedUnits: [], next: originalHistoryNextCursors.units };
        if (cursor === null)
          return {
            status: 200,
            completedUnits: [originalHistoryUnit, 'original-3', 'original-7'],
            next: originalHistoryCursors.units,
          };
      }
      if (mode === 'detail-original' && match?.[1] === profileSessionId && cursor === null)
        return { status: 200, completedUnits: [], next: null };
      return undefined;
    },
  },
  {
    method: 'GET',
    path: '/v1/publishedLogs',
    story: ({ request }) => {
      if (mode !== 'original-history') return;
      const later = new URL(request.url).searchParams.has('cursor');
      return {
        status: 200,
        publishedLogs: later ? [] : logsRecording.publishedLogs.map((log) => ({ ...log, accountId: storyViewerId })),
        next: later ? null : originalHistoryCursors.logs,
      };
    },
  },
];
