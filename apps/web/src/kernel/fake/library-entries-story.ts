import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

type LibraryStoryMode = 'recorded' | 'empty' | 'long' | 'unavailable' | 'error';
let mode: LibraryStoryMode = 'recorded';

export function setLibraryEntriesStoryMode(next: LibraryStoryMode): void {
  mode = next;
}

function response(recordings: Record<string, KernelRecording>, request: Request): KernelRecording | undefined {
  if (mode === 'recorded') return undefined;
  if (mode === 'unavailable')
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (mode === 'error')
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const recorded = recordings['library-entries'];
  if (!recorded || !Array.isArray(recorded.libraryEntries)) return undefined;
  if (mode === 'empty') return { ...recorded, libraryEntries: [] };

  const state = new URL(request.url).searchParams.get('state');
  const template = recorded.libraryEntries.find(
    (row) => typeof row === 'object' && row !== null && (!state || (row as Record<string, unknown>).state === state),
  );
  if (!template || typeof template !== 'object') return { ...recorded, libraryEntries: [] };
  const source = template as Record<string, unknown>;
  const subject =
    source.subject && typeof source.subject === 'object' ? (source.subject as Record<string, unknown>) : {};
  const entries = Array.from({ length: 12 }, (_, index) => {
    const id = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
    const label = `Library story entry ${index + 1}`;
    return {
      ...source,
      subjectId: id,
      subject: {
        ...subject,
        id,
        label: { value: label, language: 'en' },
      },
    };
  });
  return { ...recorded, libraryEntries: entries };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: ({ recordings, request }) => response(recordings, request),
  },
];
