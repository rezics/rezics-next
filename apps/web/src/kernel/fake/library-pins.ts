import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import collectionsRecording from '../recorded/library-collections.json';

export type LibraryNavigationStoryState = {
  pinCount: number;
  unavailableTarget?: boolean;
  failPins?: boolean;
  collectionsUnavailable?: boolean;
  collectionsError?: boolean;
  builtins: 'none' | 'everything' | 'everything-liked';
  collectionCount: number;
  conflict?: boolean;
};

const defaults: LibraryNavigationStoryState = {
  pinCount: 0,
  builtins: 'none',
  collectionCount: collectionsRecording.collections.length,
};
let state: LibraryNavigationStoryState = { ...defaults };
let revision = 3;
let pinIds: string[] = [];

export function setLibraryNavigationStoryState(next: Partial<LibraryNavigationStoryState>): void {
  state = { ...defaults, ...next };
  pinIds = Array.from({ length: Math.max(0, state.pinCount) }, (_, index) => `story-pinned-${index + 1}`);
  revision = 3;
}

function builtins() {
  const everything = {
    id: 'story-builtin-everything',
    membershipKind: 'dynamic',
    builtinKind: 'everything',
    title: null,
    description: null,
    curatorAccountId: 'story-viewer',
    curator: null,
    visibility: 'private',
  };
  const liked = { ...everything, id: 'story-builtin-liked', builtinKind: 'liked' };
  return state.builtins === 'everything-liked'
    ? [everything, liked]
    : state.builtins === 'everything'
      ? [everything]
      : [];
}

function ownerCollections(): KernelRecording {
  if (state.collectionsUnavailable)
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (state.collectionsError)
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const recorded = collectionsRecording.collections.slice(0, Math.max(0, state.collectionCount)).map((collection) => ({
    ...collection,
    curatorAccountId: 'story-viewer',
    curator: { ...collection.curator, id: 'story-viewer' },
  }));
  return { status: 200, collections: [...builtins(), ...recorded], next: null };
}

function openApi(): KernelRecording {
  return {
    status: 200,
    openapi: '3.1.0',
    info: { title: 'REZICS Kernel', version: '1' },
    paths: {
      '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
      '/v1/libraryPins/{collectionId}': {
        put: { operationId: 'library_pin.put' },
        delete: { operationId: 'library_pin.delete' },
      },
    },
    components: { schemas: {}, securitySchemes: {} },
  };
}

function pinTarget(collectionId: string, index: number): unknown {
  if (state.unavailableTarget && index === 0) return null;
  const targetNumber = Number(collectionId.split('-').at(-1)) || index + 1;
  return {
    id: collectionId,
    title: `Pinned collection ${targetNumber}`,
    membershipKind: 'curated',
    description: null,
    curatorAccountId: 'story-viewer',
    curator: null,
    visibility: 'private',
    memberCount: 0,
  };
}

function pins(limit: number): KernelRecording {
  if (state.failPins) return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  const rows = pinIds.slice(0, limit).map((collectionId, index) => ({
    collectionId,
    target: pinTarget(collectionId, index),
  }));
  return {
    status: 200,
    pins: rows,
    revision,
    next: pinIds.length > limit ? 'more-pins' : null,
  };
}

async function pinWrite(request: Request, collectionId: string, method: 'PUT' | 'DELETE'): Promise<KernelRecording> {
  if (state.conflict) return { status: 409, type: 'https://rezics.com/problems/conflict', code: 'conflict' };
  const payload: unknown =
    method === 'PUT'
      ? await request
          .clone()
          .json()
          .catch(() => ({}))
      : {};
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (typeof value.revision === 'number' && value.revision !== revision)
    return { status: 409, type: 'https://rezics.com/problems/conflict', code: 'conflict' };
  const old = pinIds.indexOf(collectionId);
  if (method === 'PUT' && old < 0 && pinIds.length >= 100)
    return { status: 409, type: 'https://rezics.com/problems/conflict', code: 'collection_full' };
  if (method === 'DELETE') {
    pinIds = pinIds.filter((id) => id !== collectionId);
  } else {
    if (old >= 0) pinIds.splice(old, 1);
    const after = value.after;
    const index = after === null ? 0 : typeof after === 'string' ? pinIds.indexOf(after) + 1 : pinIds.length;
    pinIds.splice(index < 0 ? pinIds.length : index, 0, collectionId);
  }
  revision += 1;
  return { status: 200, revision };
}

async function pinRecord(request: Request): Promise<KernelRecording | undefined> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/v1/openapi/json') return openApi();
  if (request.method === 'GET' && url.pathname === '/v1/libraryPins') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    return pins(limit);
  }
  const match = /^\/v1\/libraryPins\/([^/]+)$/.exec(url.pathname);
  if (match && (request.method === 'PUT' || request.method === 'DELETE'))
    return pinWrite(request, decodeURIComponent(match[1]!), request.method);
  return undefined;
}

function ownerCollectionRecord(request: Request): KernelRecording | undefined {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/v1/collections' || !url.searchParams.has('curatorAccountId'))
    return undefined;
  return ownerCollections();
}

function builtinCollectionRecord(request: Request): KernelRecording | undefined {
  const match = /^\/v1\/collections\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (request.method !== 'GET' || !match) return undefined;
  const id = decodeURIComponent(match[1]!);
  const aliasKind = id === 'dynamic-everything' ? 'everything' : id === 'dynamic-liked' ? 'liked' : undefined;
  const builtin = builtins().find((item) => item.id === id || item.builtinKind === aliasKind);
  if (builtin && aliasKind) builtin.id = id;
  return builtin ? { status: 200, collection: builtin } : undefined;
}

function builtinMembersRecord(request: Request): KernelRecording | undefined {
  const match = /^\/v1\/collections\/([^/]+)\/members$/.exec(new URL(request.url).pathname);
  if (request.method !== 'GET' || !match) return undefined;
  const id = decodeURIComponent(match[1]!);
  const aliasKind = id === 'dynamic-everything' ? 'everything' : id === 'dynamic-liked' ? 'liked' : undefined;
  return builtins().some((item) => item.id === id || item.builtinKind === aliasKind)
    ? { status: 200, members: [], next: null }
    : undefined;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/openapi/json',
    story: ({ request }) => pinRecord(request),
    fixture: ({ request }) => pinRecord(request),
  },
  {
    method: 'GET',
    path: '/v1/libraryPins',
    story: ({ request }) => pinRecord(request),
    fixture: ({ request }) => pinRecord(request),
  },
  {
    method: 'PUT',
    path: /^\/v1\/libraryPins\/[^/]+$/,
    story: ({ request }) => pinRecord(request),
    fixture: ({ request }) => pinRecord(request),
  },
  {
    method: 'DELETE',
    path: /^\/v1\/libraryPins\/[^/]+$/,
    story: ({ request }) => pinRecord(request),
    fixture: ({ request }) => pinRecord(request),
  },
  {
    method: 'GET',
    path: '/v1/collections',
    story: ({ request }) => ownerCollectionRecord(request),
    fixture: ({ request }) => ownerCollectionRecord(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/[^/]+$/,
    story: ({ request }) => builtinCollectionRecord(request),
    fixture: ({ request }) => builtinCollectionRecord(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/[^/]+\/members$/,
    story: ({ request }) => builtinMembersRecord(request),
    fixture: ({ request }) => builtinMembersRecord(request),
  },
];
