import { activeLabelStoryLabels, isLabelCatalogueStory } from './library-labels';
import { labelReadStoryFailure } from './library-labels';
import { normalizeLibraryLabelName } from '../../library/subject-label-name';
import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import { recordedBookState } from './library-entry-states.ts';

const labelIds = Array.from(
  { length: 32 },
  (_, index) => `0192f3a0-6c1e-7b2a-9d4e-${String(801 + index).padStart(12, '0')}`,
);
const storyNames = ['Reading list', 'Favorites', 'Read later'];
let subjectCount = 3;
let shelfCount = 3;
type ShelfStoryMode = 'default' | 'reading' | 'sparse';
let shelfStoryMode: ShelfStoryMode = 'default';
let nextShelfStoryMode: ShelfStoryMode = 'default';
let nextUnassignFailure = false;
let unassignFailure = false;
const createdLabels = new Map<string, { id: string; name: string; revision: number }>();
const addedAssignments = new Map<string, { id: string; labelId: string; subjectId: string; revision: number }>();
const removedAssignments = new Set<string>();

export function resetLabelAssignmentStory(): void {
  shelfStoryMode = nextShelfStoryMode;
  nextShelfStoryMode = 'default';
  unassignFailure = nextUnassignFailure;
  nextUnassignFailure = false;
  removedAssignments.clear();
  addedAssignments.clear();
  createdLabels.clear();
}

/** Story pages opt into exact populations without changing the fixture or the current fake site behavior. */
export function setLibraryLabelStorySizes(input: {
  subject?: number;
  shelf?: number;
  scenario?: ShelfStoryMode;
  unassignFailure?: boolean;
}): void {
  nextShelfStoryMode = input.scenario ?? 'default';
  nextUnassignFailure = input.unassignFailure ?? false;
  if (input.subject !== undefined) {
    const next = Math.max(0, Math.min(32, Math.floor(input.subject)));
    if (next !== subjectCount) {
      removedAssignments.clear();
      addedAssignments.clear();
      createdLabels.clear();
      subjectCount = next;
    }
  }
  if (input.shelf !== undefined) shelfCount = Math.max(0, Math.min(100, Math.floor(input.shelf)));
}

function labels() {
  return [
    ...labelIds.map((id, index) => ({
      id,
      name: index === labelIds.length - 1 ? 'Empty label' : (storyNames[index] ?? `Story label ${index + 1}`),
      revision: 1,
    })),
    ...createdLabels.values(),
    ...activeLabelStoryLabels(),
  ];
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function subjectAssignments(targetSubjectId: string): KernelRecording {
  const initial = Array.from({ length: subjectCount }, (_, index) => {
    const label = labels()[index % labelIds.length]!;
    return {
      id: `0192f3a0-6c1e-7b2a-9d4e-${String(1000 + index).padStart(12, '0')}`,
      labelId: label.id,
      subjectId: targetSubjectId,
      revision: 1,
      label: { name: label.name },
    };
  });
  const values = [...initial, ...addedAssignments.values()]
    .filter((row) => row.subjectId === targetSubjectId)
    .filter((row) => !removedAssignments.has(row.id))
    .map((row) => ({ ...row, label: { name: labels().find((label) => label.id === row.labelId)?.name ?? '' } }))
    .sort((left, right) => left.labelId.localeCompare(right.labelId));
  return { status: 200, assignments: values, next: null };
}

const readingTitles = ['The Left Hand of Darkness', 'A Wizard of Earthsea', '', 'Piranesi', 'The Dispossessed'];

function labelShelf(labelIdValue: string, request: Request): KernelRecording | undefined {
  const label = labels().find((item) => item.id === labelIdValue);
  const empty = labelIds[31] === labelIdValue;
  if (!label && !empty) return { status: 404, code: 'not_found' };
  const mode = shelfStoryMode;
  const size = empty ? 0 : shelfCount;
  const url = new URL(request.url);
  const offset = url.searchParams.get('cursor') === 'label-shelf-next' ? 20 : 0;
  // A sparse native page still owns its continuation. The next page is a replacement, not a local append.
  const sparse = mode === 'sparse';
  const pageSize = sparse ? (offset === 0 ? 1 : 2) : Math.min(Math.max(0, size - offset), 100);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 100)));
  const rows = Array.from({ length: Math.min(pageSize, limit) }, (_, pageIndex) => {
    const index = offset + pageIndex;
    const rowSubjectId = `0192f3a0-6c1e-7b2a-9d4e-${String(1100 + index).padStart(12, '0')}`;
    const tombstone = index === 2;
    return {
      id: `0192f3a0-6c1e-7b2a-9d4e-${String(1200 + index).padStart(12, '0')}`,
      labelId: labelIdValue,
      subjectId: rowSubjectId,
      revision: 1,
      subject: tombstone
        ? null
        : {
            id: rowSubjectId,
            type: 'schema:Book',
            types: ['schema:Book', 'schema:CreativeWork'],
            label: {
              value:
                mode !== 'default'
                  ? readingTitles[index % readingTitles.length] || 'Stories of Your Life and Others'
                  : `Label shelf work ${index + 1}`,
              language: 'en',
            },
            cover: null,
          },
      libraryEntry:
        index === 0
          ? {
              subjectId: rowSubjectId,
              revision: 3,
              incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000001700',
              state: recordedBookState(1),
              activeProgressSession: {
                mode: 'scalar_amount',
                amount: '42',
                total: null,
                unit: 'percent',
                dimension: 'percent',
                locator: null,
                position: null,
                completedUnitCount: 0,
              },
            }
          : index === 1
            ? {
                subjectId: rowSubjectId,
                revision: 1,
                incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000001701',
                state: recordedBookState(2),
                activeProgressSession: null,
              }
            : null,
    };
  }).filter((row) => !removedAssignments.has(row.id));
  const labelSummary = label ?? { id: labelIdValue, name: 'Empty label', revision: 1 };
  return {
    status: 200,
    assignments: rows,
    label: labelSummary,
    next: (sparse ? offset === 0 : size > offset + limit) ? 'label-shelf-next' : null,
  };
}

async function answer({ request }: { request: Request }): Promise<KernelRecording | undefined> {
  const url = new URL(request.url);
  if (isLabelCatalogueStory() && /^\/v1\/libraryLabels(?:\/[^/:]+(?::restore)?)?$/.test(url.pathname)) return undefined;
  if (
    request.method === 'GET' &&
    (url.pathname === '/v1/libraryLabelAssignments' || url.pathname === '/v1/libraryLabels')
  ) {
    const failure = labelReadStoryFailure();
    if (failure) return failure;
  }
  if (request.method === 'GET' && url.pathname === '/v1/libraryLabels') {
    const query = url.searchParams.get('q') ?? '';
    const prefix = normalizeLibraryLabelName(query);
    if (prefix !== query) {
      url.searchParams.set('q', prefix);
      return answer({ request: new Request(url, request) });
    }
    const matches = labels()
      .filter((label) => label.name.startsWith(query))
      .slice(0, 20);
    const matching = labels().filter((label) => label.name.startsWith(query));
    if (url.searchParams.has('cursor')) return { status: 200, labels: matching.slice(20, 40), next: null };
    if (matching.length > 20) return { status: 200, labels: matches, next: 'label-prefix-next' };
    return { status: 200, labels: matches, next: null };
  }
  if (request.method === 'POST' && url.pathname === '/v1/libraryLabels') {
    const input = await body(request);
    const label = {
      id: `0192f3a0-6c1e-7b2a-9d4e-${String(899 + createdLabels.size).padStart(12, '0')}`,
      name: String(input.name ?? ''),
      revision: 1,
    };
    createdLabels.set(label.id, label);
    return {
      status: 201,
      label,
    };
  }
  if (request.method === 'GET' && url.pathname === '/v1/libraryLabelAssignments') {
    const labelIdValue = url.searchParams.get('labelId');
    if (labelIdValue) return labelShelf(labelIdValue, request);
    const targetSubjectId = url.searchParams.get('subjectId');
    return targetSubjectId ? subjectAssignments(targetSubjectId) : undefined;
  }
  const action = /^\/v1\/libraryLabels\/([^/]+):(assign|unassign|restoreAssignment)$/.exec(url.pathname);
  if (request.method === 'POST' && action?.[1]) {
    const id = decodeURIComponent(action[1]);
    const input = await body(request);
    if (typeof input.subjectId !== 'string' || !input.subjectId) return;
    const assignmentId = String(input.assignmentId ?? '0192f3a0-6c1e-7b2a-9d4e-000000000999');
    const targetSubjectId = input.subjectId;
    const current = subjectAssignments(targetSubjectId).assignments as {
      id: string;
      labelId: string;
      subjectId: string;
      revision: number;
    }[];
    if (action[2] === 'unassign') {
      if (unassignFailure) {
        unassignFailure = false;
        return { status: 503, code: 'unavailable' };
      }
      removedAssignments.add(assignmentId);
      return {
        status: 200,
        deleted: true,
        headers: { 'Library-Label-Assignment-Revision': '2' },
      };
    }
    if (action[2] === 'restoreAssignment') removedAssignments.delete(assignmentId);
    const existing = current.find((row) => row.labelId === id && row.subjectId === input.subjectId);
    if (action[2] === 'assign' && !existing && current.length >= 32)
      return { status: 409, code: 'library_label_capacity' };
    const assignment =
      action[2] === 'restoreAssignment'
        ? { id: assignmentId, labelId: id, subjectId: targetSubjectId, revision: 3 }
        : (existing ?? {
            id: `0192f3a0-6c1e-7b2a-9d4e-${String(1500 + addedAssignments.size).padStart(12, '0')}`,
            labelId: id,
            subjectId: targetSubjectId,
            revision: 1,
          });
    if (!current.some((row) => row.id === assignment.id)) addedAssignments.set(assignment.id, assignment);
    return { status: 200, assignment };
  }
  return undefined;
}

export const routes: FakeRoute[] = [
  { method: 'GET', path: '/v1/libraryLabels', story: answer, fixture: answer },
  { method: 'POST', path: '/v1/libraryLabels', story: answer, fixture: answer },
  { method: 'GET', path: '/v1/libraryLabelAssignments', story: answer, fixture: answer },
  {
    method: 'POST',
    path: /^\/v1\/libraryLabels\/[^/]+:(?:assign|unassign|restoreAssignment)$/,
    story: answer,
    fixture: answer,
  },
];
