import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  admitOrganizationPage,
  moveOrganizationPlacement,
  parseOrganizationRequest,
  readOrganization,
  type OrganizationIntent,
  type OrganizationRequest,
} from '../src/knowledge/organization-read';
import { KnowledgeOrganizationReading } from '../src/knowledge/organization-model';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const notebookId = id(1),
  placementId = id(2),
  documentId = id(3),
  structureRevisionId = id(4);
const root = { kind: 'outline', notebookId, parentPlacementId: null } as const;
const row = {
  placementId,
  documentId,
  parentPlacementId: null,
  position: '99999999999999999999999999999999999999',
  title: 'Original document',
};
const dto = (request: OrganizationRequest, overrides = {}) => ({
  notebookId,
  structureRevisionId,
  parentPlacementId: request.kind === 'history' ? null : request.parentPlacementId,
  placements: [{ ...row, parentPlacementId: request.kind === 'history' ? null : request.parentPlacementId }],
  next: null,
  ...overrides,
});
const binding = { viewer: id(99), csrfToken: 'csrf-original', credential: 'captured-original' };

function fixture() {
  const requests: OrganizationRequest[] = [];
  const intents: OrganizationIntent[] = [];
  let revision = structureRevisionId;
  let result = 'uncertain';
  let failCursor = false;
  const reading = new KnowledgeOrganizationReading(
    {
      read: async (request) => {
        requests.push(structuredClone(request));
        if (request.cursor && failCursor) return { state: 'unavailable' };
        return admitOrganizationPage(
          200,
          dto(request, { structureRevisionId: revision, next: request.cursor ? null : 'opaque-next' }),
          request,
        );
      },
      prepare: async () => ({ state: 'ready', binding }),
      move: async (intent) => {
        intents.push(intent);
        return result === 'acknowledged'
          ? { state: 'acknowledged', receipt: { notebookId, placementId, structureRevisionId: id(5) } }
          : result === 'conflict'
            ? { state: 'conflict' }
            : { state: 'uncertain' };
      },
    },
    { request: root, breadcrumbs: [] },
  );
  const actions = () => reading.actions(reading.getSnapshot(), 'Notebook root');
  return {
    reading,
    requests,
    intents,
    actions,
    revision: (v: string) => {
      revision = v;
    },
    result: (v: string) => {
      result = v;
    },
    fail: (v: boolean) => {
      failCursor = v;
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('generated move keeps exact operands/key/credential; history and historical outline each request one native page', async () => {
  const calls: Request[] = [];
  const request: OrganizationRequest = { kind: 'history', notebookId, cursor: 'opaque+/=history' };
  const historical: OrganizationRequest = {
    kind: 'historical',
    notebookId,
    parentPlacementId: placementId,
    revisionId: structureRevisionId,
    cursor: 'opaque-old-parent',
  };
  const responses = [
    { notebookId, placementId, structureRevisionId: id(5) },
    { notebookId, revisions: [], next: 'sparse-history' },
    dto(historical),
  ];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      expect(call.headers.get('authorization')).toBe('Bearer captured-original');
      return Response.json(responses.shift());
    }) as typeof fetch,
  });
  const intent = {
    notebookId,
    placementId,
    expectedStructureRevisionId: structureRevisionId,
    destinationParentPlacementId: id(6),
    beforePlacementId: id(7),
    idempotencyKey: id(8),
    authorization: 'Bearer captured-original',
  };
  expect(await moveOrganizationPlacement(client, intent)).toEqual({
    state: 'acknowledged',
    receipt: { notebookId, placementId, structureRevisionId: id(5) },
  });
  expect(
    await readOrganization(client, { accountId: binding.viewer, authorization: intent.authorization, request }),
  ).toMatchObject({ state: 'ready', page: { kind: 'history', revisions: [], next: 'sparse-history' } });
  expect(
    await readOrganization(client, {
      accountId: binding.viewer,
      authorization: intent.authorization,
      request: historical,
    }),
  ).toMatchObject({
    state: 'ready',
    page: { kind: 'historical', placements: [{ ...row, parentPlacementId: placementId }] },
  });
  expect(calls).toHaveLength(3);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/knowledge/notebooks/${notebookId}/placements/${placementId}:move`);
  expect(calls[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(intent.idempotencyKey));
  expect(await calls[0]!.json()).toEqual({
    expectedStructureRevisionId: structureRevisionId,
    destinationParentPlacementId: id(6),
    beforePlacementId: id(7),
  });
  expect(Object.fromEntries(new URL(calls[1]!.url).searchParams)).toEqual({ limit: '20', cursor: 'opaque+/=history' });
  expect(Object.fromEntries(new URL(calls[2]!.url).searchParams)).toEqual({
    limit: '20',
    cursor: 'opaque-old-parent',
    revisionId: structureRevisionId,
    parentPlacementId: placementId,
  });
});

test('uncertain retry is immutable and acknowledgement is independent of a newer fresh outline', async () => {
  const f = fixture();
  await f.reading.open();
  f.actions().source((f.reading.getSnapshot().page as { placements: (typeof row)[] }).placements[0]!);
  f.actions().review(null);
  await settle();
  const reviewed = f.reading.getSnapshot().review!;
  f.actions().confirm();
  await settle();
  expect(f.reading.getSnapshot().command).toBe('uncertain');
  f.actions().root();
  f.actions().history();
  f.actions().cancel();
  expect(f.requests).toHaveLength(1);
  f.result('acknowledged');
  f.actions().confirm();
  await settle();
  expect(f.intents[0]).toBe(f.intents[1]!);
  expect(f.intents[1]).toBe(reviewed.intent);
  expect(Object.isFrozen(reviewed.intent.binding)).toBe(true);
  expect(f.reading.getSnapshot().receipt?.structureRevisionId).toBe(id(5));
  expect(f.reading.getSnapshot().page).toBeUndefined();
  f.revision(id(9));
  f.actions().current();
  await settle();
  expect(f.requests).toHaveLength(2);
  expect(f.reading.getSnapshot()).toMatchObject({
    command: 'idle',
    receipt: { structureRevisionId: id(5) },
    page: { structureRevisionId: id(9) },
  });
});

test('conflict retains the choice then requires fresh source and destination selection with a new deliberate command', async () => {
  const f = fixture();
  await f.reading.open();
  f.actions().source((f.reading.getSnapshot().page as { placements: (typeof row)[] }).placements[0]!);
  f.actions().review(null);
  await settle();
  const old = f.reading.getSnapshot().review!;
  f.result('conflict');
  f.actions().confirm();
  await settle();
  f.revision(id(9));
  f.actions().restart();
  await settle();
  expect(f.reading.getSnapshot()).toMatchObject({ previous: old, source: undefined, review: undefined });
  f.actions().review(null);
  await settle();
  expect(f.intents).toHaveLength(1);
  f.actions().source((f.reading.getSnapshot().page as { placements: (typeof row)[] }).placements[0]!);
  f.actions().review(null);
  await settle();
  expect(f.reading.getSnapshot().review?.intent.expectedStructureRevisionId).toBe(id(9));
  expect(f.reading.getSnapshot().review?.intent.idempotencyKey).not.toBe(old.intent.idempotencyKey);
  expect(f.intents).toHaveLength(1);
});

test('sparse More replaces one page, Retry repeats its cursor and stale traversal explicitly restarts the parent', async () => {
  const f = fixture();
  await f.reading.open();
  f.fail(true);
  f.actions().more();
  await settle();
  f.actions().retry();
  await settle();
  expect(f.requests[1]).toEqual(f.requests[2]);
  f.fail(false);
  f.revision(id(9));
  f.actions().retry();
  await settle();
  expect(f.reading.getSnapshot().state).toBe('changed');
  f.actions().restart();
  await settle();
  expect(f.requests.at(-1)).toEqual(root);
  expect(f.reading.getSnapshot().state).toBe('ready');
});

test('HTTP inputs and third-party pages admit native bounds and unavailable-history rows without inventing a tree', () => {
  expect(parseOrganizationRequest({ ...root, cursor: '' })).toBeNull();
  expect(parseOrganizationRequest({ ...root, kind: 'historical', revisionId: 'latest' })).toBeNull();
  const request = { kind: 'history', notebookId } as const;
  const revision = {
    structureRevisionId,
    revisionNumber: '1',
    historyAvailable: false,
    changeKind: 'legacy',
    createdAt: '2026-11-11T12:00:00Z',
    changes: [],
  };
  expect(admitOrganizationPage(200, { notebookId, revisions: [revision], next: null }, request)).toMatchObject({
    state: 'ready',
    page: { revisions: [{ historyAvailable: false }] },
  });
  expect(admitOrganizationPage(200, { notebookId, revisions: Array(21).fill(revision), next: null }, request)).toEqual({
    state: 'unavailable',
  });
});
