import { normalizeLibraryLabelName } from '../../library/subject-label-name';
import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';

type Label = { id: string; name: string; revision: number };
type Operation = 'create' | 'rename' | 'delete' | 'restore';
type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  key: string | null;
  authorization: string | null;
};
export const labelOperations = [
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
];

export function labelReadStoryFailure(): KernelRecording | undefined {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  const variant = new URL(context?.url ?? '/library', 'http://rezics.local').searchParams.get('labelRead');
  if (variant === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
  if (variant === 'preparing') return { status: 503, code: 'index_not_ready' };
  if (variant === 'denied') return { status: 404, code: 'not_found' };
  return undefined;
}
const sample: Label[] = [
  { id: '01a17a3b-6ef3-71cc-80d0-f4ccb5814bbf', name: 'Winter reads', revision: 9 },
  { id: '01a17a3b-6ef3-71cc-80d0-f4ccb5814bc0', name: '読み返したい本 · Books to revisit', revision: 3 },
];

/** Contract-shaped fixture, deliberately separate from recorded kernel evidence. Each instance owns its state. */
export function createLibraryLabelsFake(
  options: {
    labels?: Label[];
    next?: string | null;
    deleteRevision?: number | null;
    externalRename?: string;
  } = {},
) {
  const removed = new Map<string, Label>();
  const refusals = new Map<Operation, { code: string; detail?: string }>();
  const receipts = new Map<string, KernelRecording>();
  const lostReplies = new Set<Operation>();
  let externalRename = options.externalRename;
  const fake = {
    labels: structuredClone(options.labels ?? sample),
    next: options.next ?? null,
    deleteRevision: options.deleteRevision === undefined ? 73 : options.deleteRevision,
    admitted: [...labelOperations],
    calls: [] as Call[],
    refuse(operation: Operation, code: string, detail?: string) {
      refusals.set(operation, { code, ...(detail === undefined ? {} : { detail }) });
    },
    loseNextReply(operation: Operation) {
      lostReplies.add(operation);
    },
    async answer(request: Request): Promise<KernelRecording | undefined> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path !== '/v1/platform/exposure' && !/^\/v1\/libraryLabels(?:\/[^/]+)?$/.test(path)) return undefined;
      const body =
        request.method === 'POST' || request.method === 'PATCH'
          ? ((await request.json()) as { name?: string; revision?: number })
          : null;
      const key = request.headers.get('idempotency-key');
      fake.calls.push({
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams),
        body,
        key,
        authorization: request.headers.get('authorization'),
      });
      if (path === '/v1/platform/exposure') return { status: 200, admitted: fake.admitted };
      if (request.method === 'GET') {
        const failure = labelReadStoryFailure();
        if (failure) return failure;
      }
      if (request.method === 'GET' && url.searchParams.has('cursor')) return { status: 200, labels: [], next: null };
      if (request.method === 'GET' && url.searchParams.has('q')) {
        const q = normalizeLibraryLabelName(url.searchParams.get('q')!);
        return {
          status: 200,
          labels: structuredClone(fake.labels.filter((label) => label.name.startsWith(q))),
          next: fake.next,
        };
      }
      if (request.method === 'GET') return { status: 200, labels: structuredClone(fake.labels), next: fake.next };
      if (!key) return { status: 400, code: 'invalid_request' };
      const previous = receipts.get(key);
      if (previous) return structuredClone(previous);
      const restore = path.endsWith(':restore');
      const operation: Operation = restore
        ? 'restore'
        : request.method === 'DELETE'
          ? 'delete'
          : request.method === 'PATCH'
            ? 'rename'
            : 'create';
      const refused = refusals.get(operation);
      if (refused) return { status: 409, ...refused };
      const id = path.slice('/v1/libraryLabels/'.length).replace(/:restore$/, '');
      const label = fake.labels.find((item) => item.id === id);
      if (operation === 'rename' && label && externalRename !== undefined) {
        label.name = externalRename;
        label.revision += 1;
        externalRename = undefined;
        return { status: 409, code: 'conflict' };
      }
      let result: KernelRecording;
      if (operation === 'restore') {
        const historic = removed.get(id);
        if (!historic || historic.revision !== body?.revision)
          return { status: 409, code: 'library_label_restore_stale' };
        if (fake.labels.some((item) => item.name === historic.name))
          return { status: 409, code: 'library_label_restore_occupied' };
        const restored = { ...historic, revision: historic.revision + 1 };
        removed.delete(id);
        fake.labels.push(restored);
        result = { status: 200, label: { id, revision: restored.revision } };
      } else if (operation === 'delete') {
        if (!label || label.revision !== Number(url.searchParams.get('revision')))
          return { status: 409, code: 'conflict' };
        const revision = fake.deleteRevision;
        removed.set(id, { ...label, revision: revision ?? 74 });
        fake.labels = fake.labels.filter((item) => item.id !== id);
        result = {
          status: 200,
          deleted: true,
          ...(revision === null ? {} : { headers: { 'Library-Label-Revision': String(revision) } }),
        };
      } else {
        if (operation === 'rename' && (!label || label.revision !== body?.revision))
          return { status: 409, code: 'conflict' };
        const name = body?.name?.normalize('NFC').trim().replace(/\s+/gu, ' ') ?? '';
        if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || [...name].length > 100)
          return { status: 400, code: 'invalid_request' };
        if (fake.labels.some((item) => item.id !== label?.id && item.name === name))
          return { status: 409, code: 'conflict' };
        const updated = label
          ? { ...label, name, revision: label.revision + Number(label.name !== name) }
          : { id: crypto.randomUUID(), name, revision: 1 };
        fake.labels = label ? fake.labels.map((item) => (item.id === id ? updated : item)) : [...fake.labels, updated];
        result = { status: label ? 200 : 201, label: { id: updated.id, revision: updated.revision } };
      }
      receipts.set(key, structuredClone(result));
      if (lostReplies.delete(operation)) return { status: 503, code: 'unavailable' };
      return result;
    },
    fetch: (async (input, init) => {
      const recording = await fake.answer(new Request(input, init));
      if (!recording) return new Response(null, { status: 404 });
      const { status, headers, ...body } = recording;
      return Response.json(body, { status, ...(headers ? { headers: headers as HeadersInit } : {}) });
    }) as typeof fetch,
  };
  return fake;
}

let catalogueStoryActive = false;
export function setLabelCatalogueStory(active: boolean) {
  catalogueStoryActive = active;
}
export function activeLabelStoryLabels() {
  return catalogueStoryActive ? story.labels : [];
}
export function isLabelCatalogueStory() {
  return catalogueStoryActive;
}
let story = createLibraryLabelsFake();
export function selectLabelStory(
  state:
    | 'catalogue'
    | 'empty'
    | 'next'
    | 'conflict'
    | 'undo'
    | 'directory'
    | 'rename-recovery'
    | 'uncertain-rename'
    | 'uncertain-delete',
) {
  catalogueStoryActive = true;
  story = createLibraryLabelsFake({
    labels:
      state === 'empty'
        ? []
        : state === 'directory'
          ? [
              ...sample,
              { id: '01a17a3b-6ef3-71cc-80d0-f4ccb5814bc1', name: 'Family read-alouds', revision: 2 },
              { id: '01a17a3b-6ef3-71cc-80d0-f4ccb5814bc2', name: 'Worlds to return to', revision: 6 },
              { id: '01a17a3b-6ef3-71cc-80d0-f4ccb5814bc3', name: 'For a quiet weekend', revision: 1 },
            ]
          : sample,
    next: state === 'next' ? 'next-label-page' : null,
    ...(state === 'rename-recovery' ? { externalRename: 'Winter reading · shared update' } : {}),
  });
  if (state === 'conflict') story.refuse('rename', 'conflict');
  if (state === 'uncertain-rename') story.loseNextReply('rename');
  if (state === 'uncertain-delete') story.loseNextReply('delete');
}
// Discovered insert-only by fake-modules.ts's existing fake/*.ts registry.
export const routes: FakeRoute[] = [
  { method: 'GET', path: '/v1/libraryLabels', story: ({ request }) => story.answer(request) },
  { method: 'POST', path: '/v1/libraryLabels', story: ({ request }) => story.answer(request) },
  { method: 'PATCH', path: /^\/v1\/libraryLabels\/[^/]+$/, story: ({ request }) => story.answer(request) },
  { method: 'DELETE', path: /^\/v1\/libraryLabels\/[^/]+$/, story: ({ request }) => story.answer(request) },
  { method: 'POST', path: /^\/v1\/libraryLabels\/[^/]+:restore$/, story: ({ request }) => story.answer(request) },
];
