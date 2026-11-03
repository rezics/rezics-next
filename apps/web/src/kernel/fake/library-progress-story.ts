import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import sessionsRecording from '../recorded/library-progress-sessions.json';
import changesRecording from '../recorded/library-progress-changes.json';
import sessionRecording from '../recorded/library-progress-session.json';
import logsRecording from '../recorded/library-published-logs.json';
import { storyViewerId } from './identities';

export type LibraryProgressStoryMode =
  | 'recorded'
  | 'none'
  | 'long'
  | 'constructed-unknown-identity'
  | 'unavailable'
  | 'error'
  | 'detail-empty'
  | 'detail-long'
  | 'original-history';

export const originalHistoryCursors = {
  changes: 'changes/+?q=原文#一% &==',
  units: 'units/+?q=原文#二% &==',
  logs: 'logs/+?q=原文#三% &==',
};
export const originalHistoryUnit = `historic-unit-${'unbroken-original-key-'.repeat(5)}`;

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
    path: /^\/v1\/progressSessions\/[^/]+$/,
    story: () => {
      if (mode === 'unavailable') return failed('unavailable');
      if (mode === 'error') return failed('internal_error');
      if (mode === 'original-history')
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
      return undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/[^/]+\/changes$/,
    story: ({ request }) => {
      if (mode === 'original-history')
        return {
          status: 200,
          changes: new URL(request.url).searchParams.has('cursor')
            ? []
            : Array.from({ length: 12 }, (_, index) => ({
                ...changesRecording.changes[0],
                id: `${sessionRecording.progressSession.id}:${index + 2}`,
                revision: index + 2,
                intent: { add: [index === 0 ? originalHistoryUnit : `original-${index}`] },
              })),
          next: new URL(request.url).searchParams.has('cursor') ? null : originalHistoryCursors.changes,
        };
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
    path: /^\/v1\/progressSessions\/[^/]+\/completedUnits$/,
    story: ({ request }) => {
      if (mode !== 'original-history') return;
      const later = new URL(request.url).searchParams.has('cursor');
      return {
        status: 200,
        completedUnits: later ? [] : [originalHistoryUnit, 'original-3', 'original-7'],
        next: later ? null : originalHistoryCursors.units,
      };
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
