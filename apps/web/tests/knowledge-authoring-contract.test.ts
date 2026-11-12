import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  knowledgeAuthoringDestination,
  knowledgeAuthoringNotebookSelection,
  knowledgeAuthoringTemplateDraft,
} from '../src/knowledge/authoring.ts';
import {
  admitKnowledgeOutline,
  admitKnowledgeOwnedNotebooks,
  knowledgeOutlineWire,
  knowledgeOwnedNotebooksWire,
  KNOWLEDGE_NAVIGATION_BREADCRUMB_LIMIT,
  KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM,
  KNOWLEDGE_NAVIGATION_PAGE_LIMIT,
  parseKnowledgeNavigationCursor,
  pushKnowledgeBreadcrumb,
  readKnowledgeOutline,
  readKnowledgeOwnedNotebooks,
} from '../src/knowledge/navigation.ts';
import { createKnowledgePrivateDocument } from '../src/knowledge/private-knowledge';
import { knowledgeBody, knowledgeSubjectId } from '../src/stories/knowledge-document-fixtures';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const otherNotebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000018';
const notebookSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000044';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const nextStructureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000016';
const parentPlacementId = '0192f3a0-6c1e-7b2a-9d4e-000000000015';
const placementId = '0192f3a0-6c1e-7b2a-9d4e-000000000014';
const documentId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const authorization = 'Bearer private-writer-token';
const createdAt = '2026-11-13T12:00:00.000Z';

const notebook = {
  notebookId,
  subjectId: notebookSubjectId,
  title: 'Owned field notebook',
  structureRevisionId,
  createdAt,
};

function clientFor(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  return { calls, client };
}

test('owned-notebook and outline wires always send limit 20 with an opaque cursor', () => {
  expect(knowledgeOwnedNotebooksWire(null)).toEqual({ limit: KNOWLEDGE_NAVIGATION_PAGE_LIMIT });
  expect(knowledgeOwnedNotebooksWire('page-2')).toEqual({ limit: 20, cursor: 'page-2' });
  expect(knowledgeOutlineWire(null, null)).toEqual({ limit: 20 });
  expect(knowledgeOutlineWire(parentPlacementId, 'child-2')).toEqual({
    limit: 20,
    cursor: 'child-2',
    parentPlacementId,
  });
  expect(parseKnowledgeNavigationCursor('')).toBeNull();
  expect(parseKnowledgeNavigationCursor('x'.repeat(KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM))).toBe(
    'x'.repeat(KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM),
  );
  expect(parseKnowledgeNavigationCursor('x'.repeat(KNOWLEDGE_NAVIGATION_CURSOR_MAXIMUM + 1))).toBeUndefined();
});

test('owned-notebook admission keeps native order, sparse next and the 20-row bound', () => {
  expect(admitKnowledgeOwnedNotebooks(200, { notebooks: [notebook], next: 'later' })).toEqual({
    state: 'ready',
    page: { notebooks: [notebook], next: 'later' },
  });
  expect(admitKnowledgeOwnedNotebooks(200, { notebooks: [], next: null })).toEqual({
    state: 'ready',
    page: { notebooks: [], next: null },
  });
  expect(
    admitKnowledgeOwnedNotebooks(200, { notebooks: Array.from({ length: 21 }, () => notebook), next: null }).state,
  ).toBe('unavailable');
  expect(admitKnowledgeOwnedNotebooks(200, { notebooks: [{ ...notebook, title: '' }], next: null }).state).toBe(
    'unavailable',
  );
  expect(admitKnowledgeOwnedNotebooks(200, { notebooks: [notebook] }).state).toBe('unavailable');
  expect(admitKnowledgeOwnedNotebooks(401, {})).toEqual({ state: 'denied', status: 401 });
  expect(admitKnowledgeOwnedNotebooks(409, {})).toEqual({ state: 'stale', status: 409 });
});

test('outline admission matches the requested notebook and parent, including empty sparse pages', () => {
  const placement = {
    placementId,
    documentId,
    parentPlacementId: null,
    position: '0',
    title: 'Inspiration',
  };
  expect(
    admitKnowledgeOutline(
      200,
      {
        notebookId,
        structureRevisionId,
        parentPlacementId: null,
        placements: [placement],
        next: null,
      },
      { notebookId, parentPlacementId: null },
    ),
  ).toEqual({
    state: 'ready',
    page: {
      notebookId,
      structureRevisionId,
      parentPlacementId: null,
      placements: [placement],
      next: null,
    },
  });
  const nested = { ...placement, parentPlacementId, title: 'Scene under the arc' };
  expect(
    admitKnowledgeOutline(
      200,
      {
        notebookId,
        structureRevisionId,
        parentPlacementId,
        placements: [nested],
        next: 'more',
      },
      { notebookId, parentPlacementId },
    ).state,
  ).toBe('ready');
  expect(
    admitKnowledgeOutline(
      200,
      {
        notebookId: otherNotebookId,
        structureRevisionId,
        parentPlacementId: null,
        placements: [],
        next: null,
      },
      { notebookId, parentPlacementId: null },
    ).state,
  ).toBe('unavailable');
  expect(
    admitKnowledgeOutline(
      200,
      {
        notebookId,
        structureRevisionId,
        parentPlacementId: null,
        placements: [{ ...placement, parentPlacementId }],
        next: null,
      },
      { notebookId, parentPlacementId: null },
    ).state,
  ).toBe('unavailable');
  expect(admitKnowledgeOutline(404, {}, { notebookId, parentPlacementId: null })).toEqual({
    state: 'not-found',
    status: 404,
  });
});

test('inventory selection and observed outline are the only destination authority', () => {
  const row = knowledgeAuthoringNotebookSelection(notebook);
  expect(row).toEqual(notebook);
  const outline = {
    notebookId,
    structureRevisionId: nextStructureRevisionId,
    parentPlacementId: null,
    placements: [],
    next: null,
  };
  expect(knowledgeAuthoringDestination(row, outline, 'ignored')).toEqual({
    notebookId,
    notebookTitle: notebook.title,
    subjectId: notebookSubjectId,
    parentPlacementId: null,
    parentTitle: null,
    structureRevisionId: nextStructureRevisionId,
  });
  const nestedOutline = { ...outline, parentPlacementId };
  expect(knowledgeAuthoringDestination(row, nestedOutline, 'Character arc')).toMatchObject({
    parentPlacementId,
    parentTitle: 'Character arc',
    subjectId: notebookSubjectId,
  });
  expect(knowledgeAuthoringDestination(row, { ...outline, notebookId: otherNotebookId }, null)).toBeNull();
  const draft = knowledgeAuthoringTemplateDraft(
    { kind: 'inspiration', title: 'Inspiration', body: 'What this Subject suggests.' },
    'en',
  );
  expect(draft.title).toBe('Inspiration');
  expect(JSON.stringify(draft.body)).toContain('What this Subject suggests.');
});

test('visited breadcrumbs keep at most 32 observed placements and never invent ancestry', () => {
  let trail: { placementId: string; title: string }[] = [];
  for (let index = 0; index < 40; index++) {
    const id = `0192f3a0-6c1e-7b2a-9d4e-${String(index).padStart(12, '0')}`;
    trail = pushKnowledgeBreadcrumb(trail, { placementId: id, title: `Visit ${index}` });
  }
  expect(trail).toHaveLength(KNOWLEDGE_NAVIGATION_BREADCRUMB_LIMIT);
  expect(trail[0]!.title).toBe('Visit 8');
  expect(trail.at(-1)!.title).toBe('Visit 39');
});

test('current-viewer owned list and outline reads use no-store replacing pages', async () => {
  const { calls, client } = clientFor((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/knowledge/notebooks') && !url.pathname.includes(notebookId)) {
      expect(request.method).toBe('GET');
      expect(request.cache).toBe('no-store');
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('cursor')).toBe('page-2');
      return Response.json({ notebooks: [notebook], next: null });
    }
    expect(url.pathname).toBe(`/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/outline`);
    expect(url.searchParams.get('parentPlacementId')).toBe(parentPlacementId);
    return Response.json({
      notebookId,
      structureRevisionId,
      parentPlacementId,
      placements: [],
      next: null,
    });
  });
  expect(await readKnowledgeOwnedNotebooks(client, { accountId, cursor: 'page-2', authorization })).toMatchObject({
    state: 'ready',
    page: { notebooks: [notebook], next: null },
  });
  expect(
    await readKnowledgeOutline(client, {
      accountId,
      notebookId,
      parentPlacementId,
      cursor: null,
      authorization,
    }),
  ).toMatchObject({ state: 'ready', page: { parentPlacementId, placements: [] } });
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/accounts/${accountId}/knowledge/notebooks`);
  expect(await readKnowledgeOwnedNotebooks(client, { accountId, cursor: 'x'.repeat(4097), authorization })).toEqual({
    state: 'unavailable',
    status: 400,
  });
});

test('document create sends the observed structure revision and explicit parent placement', async () => {
  const requests: Request[] = [];
  const { client } = clientFor(async (request) => {
    requests.push(request);
    return Response.json(
      { notebookId, documentId, placementId, revisionId, structureRevisionId: nextStructureRevisionId },
      { status: 201 },
    );
  });
  const nested = await createKnowledgePrivateDocument(client, {
    notebookId,
    structureRevisionId,
    parentPlacementId,
    subjectId: notebookSubjectId,
    title: 'Scene',
    language: 'en',
    body: knowledgeBody('What happens in this scene.'),
    licence: 'LicenseRef-rezics-terms',
    idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000013',
    authorization,
  });
  expect(nested).toEqual({
    state: 'acknowledged',
    receipt: { notebookId, documentId, placementId, revisionId, structureRevisionId: nextStructureRevisionId },
  });
  const body = await requests[0]!.json();
  expect(body).toMatchObject({
    expectedStructureRevisionId: structureRevisionId,
    parentPlacementId,
    subjectIds: [notebookSubjectId],
  });
  expect(JSON.stringify(body)).not.toContain(knowledgeSubjectId);
});
