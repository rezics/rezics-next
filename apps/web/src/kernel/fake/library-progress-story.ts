import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import sessionsRecording from '../recorded/library-progress-sessions.json';
import changesRecording from '../recorded/library-progress-changes.json';

export type LibraryProgressStoryMode =
  | 'recorded'
  | 'none'
  | 'long'
  | 'unavailable'
  | 'error'
  | 'detail-empty'
  | 'detail-long';

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

function list(): KernelRecording | undefined {
  if (mode === 'unavailable') return failed('unavailable');
  if (mode === 'error') return failed('internal_error');
  if (mode === 'none') return { status: 200, progressSessions: [], next: null };
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
      return undefined;
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/[^/]+\/changes$/,
    story: () => {
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
];
