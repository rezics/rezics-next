import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

type LibraryStoryMode = 'recorded' | 'empty' | 'long' | 'unavailable' | 'error' | 'type-filter' | 'type-empty';
let mode: LibraryStoryMode = 'recorded';
let typesState: 'loaded' | 'unavailable' = 'loaded';

export function setLibraryTypesStoryState(next: typeof typesState): void {
  typesState = next;
}

export function setLibraryEntriesStoryMode(next: LibraryStoryMode): void {
  mode = next;
  typesState = 'loaded';
}

function response(recordings: Record<string, KernelRecording>, request: Request): KernelRecording | undefined {
  if (mode === 'recorded') return undefined;
  if (mode === 'unavailable')
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (mode === 'error')
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const recorded = recordings['library-entries'];
  if (!recorded || !Array.isArray(recorded.libraryEntries)) return undefined;
  if (mode === 'type-empty') return { ...recorded, libraryEntries: [], next: null };
  if (mode === 'type-filter') {
    // Constructed HTTP story inputs for the actual route/adapter, not native outcome evidence.
    const type = new URL(request.url).searchParams.get('type');
    const rows = recorded.libraryEntries.slice(0, 3).map((value, index) => {
      const row = value as Record<string, unknown>;
      const subject = row.subject as Record<string, unknown>;
      const type = index === 0 ? 'schema:Movie' : 'schema:Book';
      return { ...row, subject: { ...subject, type, types: [type] } };
    });
    return { ...recorded, libraryEntries: rows.filter((row) => !type || row.subject.type === type), next: null };
  }
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
    path: '/v1/libraryShelfTypes',
    story: ({ request }) =>
      typesState === 'unavailable'
        ? { status: 503, code: 'unavailable', type: 'https://rezics.com/problems/unavailable' }
        : new URL(request.url).searchParams.has('cursor')
          ? { status: 200, types: [{ type: 'schema:Movie', count: 37 }], next: null }
          : { status: 200, types: [{ type: 'schema:Book', count: 142 }], next: 'constructed-type-page' },
  },
  {
    method: 'GET',
    path: '/v1/libraryEntries',
    story: ({ recordings, request }) => response(recordings, request),
  },
];
