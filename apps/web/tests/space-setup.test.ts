import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import spaceRecording from '../src/kernel/recorded/space.json';
import realmRecording from '../src/kernel/recorded/realm.json';
import boardRecording from '../src/kernel/recorded/board-realm.json';
import {
  applySetupResult,
  commandSetup,
  readSetup,
  readSetupChoice,
  setupAttempt,
  retainSetupAttempt,
  type SetupSnapshot,
} from '../src/community/space-setup';

const key = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const nextKey = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const schemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const conceptId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const empty: SetupSnapshot = {
  kind: 'ready',
  space: null,
  realm: null,
  permitted: { address: false, settings: false, scheme: false, board: false },
};

// Boundary responses exercise the installed typed HTTP client; native authority proof runs after integration.
test('a permitted launch uses returned identities, command headers and resolved selections to reach its home and board', async () => {
  const requests: Request[] = [];
  let addressed = false;
  let createdRealm = false;
  const space = { ...spaceRecording.space, address: null, realmId: null };
  const realm = { ...realmRecording.realm, boardSchemeId: null };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      expect(request.headers.get('authorization')).toBe('Bearer creator');
      if (path === '/v1/viewerActions')
        return Response.json({
          resources: [
            {
              type: 'community.space',
              id: space.spaceId,
              viewerActions: [{ action: 'space:manage', operations: ['space_address.change'] }],
            },
            ...(createdRealm
              ? [
                  {
                    type: 'community.realm',
                    id: realm.realmId,
                    viewerActions: [
                      { action: 'realm:manage', operations: ['realm.update', 'realm.board_scheme'] },
                      { action: 'board:create', operations: ['board.create'] },
                    ],
                  },
                ]
              : []),
          ],
        });
      if (path.startsWith('/v1/contexts/'))
        return Response.json({
          context: { id: realm.contextId, kind: 'community', labels: { en: 'Reading' }, settings: null, defaults: {} },
        });
      if (path.startsWith('/v1/subjects/'))
        return Response.json({
          subject: {
            id: path.split('/').at(-1),
            type: path.endsWith(schemeId) ? 'skos:ConceptScheme' : 'skos:Concept',
            labels: { en: 'Discussion' },
          },
          summary: null,
        });
      if (path.endsWith('/address')) {
        addressed = true;
        return Response.json({ space: { ...space, address: 'quiet-novels', headRevisionId: nextKey } });
      }
      if (path.endsWith('/boards')) return Response.json(boardRecording, { status: 201 });
      if (path.endsWith('/boardScheme')) {
        realm.boardSchemeId = schemeId;
        return Response.json({ realm: { ...realm, headRevisionId: nextKey } });
      }
      if (path === '/v1/realms') {
        createdRealm = true;
        return Response.json({ realm }, { status: 201 });
      }
      if (path.startsWith('/v1/realms/')) return Response.json({ realm });
      return Response.json(
        {
          space: { ...space, address: addressed ? 'quiet-novels' : null, realmId: createdRealm ? realm.realmId : null },
        },
        { status: request.method === 'POST' ? 201 : 200 },
      );
    },
  });
  const created = await commandSetup(client, 'Bearer creator', {
    step: 'space',
    key,
    title: space.title,
    summary: space.summary,
  });
  let state = applySetupResult(empty, created);
  expect(state.space?.id).toBe(space.spaceId);
  state = applySetupResult(
    state,
    await commandSetup(client, 'Bearer creator', {
      step: 'address',
      key: nextKey,
      spaceId: space.spaceId,
      head: space.headRevisionId,
      address: 'quiet-novels',
    }),
  );
  expect(state.space?.address).toBe('quiet-novels');
  expect(await readSetupChoice(client, 'Bearer creator', { kind: 'context', id: realm.contextId })).toEqual({
    id: realm.contextId,
    label: 'Reading',
  });
  state = applySetupResult(
    state,
    await commandSetup(client, 'Bearer creator', {
      step: 'realm',
      key,
      spaceId: space.spaceId,
      title: realm.title,
      summary: realm.summary,
      visibility: 'public',
      contextId: realm.contextId,
    }),
  );
  expect(state.realm?.id).toBe(realm.realmId);
  await commandSetup(client, 'Bearer creator', {
    step: 'settings',
    key: nextKey,
    realmId: realm.realmId,
    head: realm.headRevisionId,
    title: 'Edited circle',
    summary: 'Saved work',
    visibility: 'protected',
    contextId: realm.contextId,
  });
  expect(await readSetupChoice(client, 'Bearer creator', { kind: 'scheme', id: schemeId })).toEqual({
    id: schemeId,
    label: 'Discussion',
  });
  state = applySetupResult(
    state,
    await commandSetup(client, 'Bearer creator', {
      step: 'scheme',
      key,
      realmId: realm.realmId,
      head: realm.headRevisionId,
      schemeId,
    }),
  );
  expect(state.realm?.schemeId).toBe(schemeId);
  expect(await readSetupChoice(client, 'Bearer creator', { kind: 'concept', id: conceptId })).toEqual({
    id: conceptId,
    label: 'Discussion',
  });
  const board = await commandSetup(client, 'Bearer creator', {
    step: 'board',
    key,
    realmId: realm.realmId,
    conceptId,
    title: 'Start here',
    visibility: 'published',
    purpose: 'discussion',
  });
  expect(board).toEqual({ kind: 'board', id: boardRecording.board.id });
  const current = await readSetup(client, 'Bearer creator', space.spaceId);
  expect(current.kind === 'ready' && current.permitted).toEqual({
    address: true,
    settings: true,
    scheme: true,
    board: true,
  });
  const writes = requests.filter((request) => request.method !== 'GET' && !request.url.endsWith('viewerActions'));
  expect(writes.every((request) => request.headers.has('idempotency-key'))).toBe(true);
  expect(writes.find((request) => request.url.endsWith('/address'))?.headers.get('if-match')).toBe(
    JSON.stringify(space.headRevisionId),
  );
  expect(writes.some((request) => /membership|members|grants|contexts/.test(request.url))).toBe(false);
});

test('uncertain retry and a head conflict retain identities and entered work; current authority refusals never become success', async () => {
  const seen: { key: string | null; body: unknown }[] = [];
  let status = 503;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
      if (status !== 201)
        return Response.json(
          { code: status === 412 ? 'precondition_failed' : status === 403 ? 'forbidden' : 'dependency_unavailable' },
          { status },
        );
      return Response.json(spaceRecording, { status });
    },
  });
  const draft = { step: 'space' as const, title: 'My entered title', summary: 'Keep my work' };
  const original = setupAttempt(null, draft, key);
  expect(Object.isFrozen(original)).toBe(true);
  expect(retainSetupAttempt(await commandSetup(client, 'Bearer creator', original))).toBe(true);
  const retry = setupAttempt(original, { ...draft, title: 'Other text' }, nextKey);
  expect(retry).toBe(original);
  expect(retry).toEqual({ step: 'space', key, title: 'My entered title', summary: 'Keep my work' });
  status = 201;
  const state = applySetupResult(empty, await commandSetup(client, 'Bearer creator', retry));
  expect(seen[0]).toEqual(seen[1]);
  expect(state.space?.id).toBe(spaceRecording.space.spaceId);
  status = 412;
  const addressDraft = {
    step: 'address' as const,
    spaceId: state.space!.id,
    head: state.space!.head,
    address: 'my-entered-address',
  };
  const conflict = await commandSetup(client, 'Bearer creator', setupAttempt(null, addressDraft, nextKey));
  expect(conflict).toEqual({ kind: 'failure', reason: 'conflict', status: 412 });
  expect(applySetupResult(state, conflict)).toBe(state);
  expect(addressDraft.address).toBe('my-entered-address');
  expect(draft.title).toBe('My entered title');
  status = 403;
  const denied = await commandSetup(client, 'Bearer creator', {
    step: 'board',
    key,
    realmId: realmRecording.realm.realmId,
    conceptId,
    title: 'Retained board',
    visibility: 'published',
    purpose: 'discussion',
  });
  expect(denied).toEqual({ kind: 'failure', reason: 'denied', status: 403 });
  expect(applySetupResult(state, denied)).toBe(state);
  expect(retainSetupAttempt(denied)).toBe(false);
});

// Product rendering is kept with the two transport outcomes above; story plays exercise actual advance/save/retry.
async function renderSetup(initial: SetupSnapshot | import('../src/community/space-setup').SetupFailure) {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { SpaceSetupForm } = await import('../src/community/space-setup-form');
  const transport: import('../src/community/space-setup-form').SetupTransport = {
    command: async () => ({ kind: 'failure', reason: 'denied', status: 403 }),
    read: async () => initial,
    choice: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
  };
  const root = createRootRoute({ component: () => createElement(SpaceSetupForm, { initial, transport }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/realms/new'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('the actual setup starts with one identity form and keeps later steps progressive without a fabricated Realm', async () => {
  const { m } = await import('../src/paraglide/messages.js');
  const html = await renderSetup(empty);
  expect(html.match(/<form/g)).toHaveLength(1);
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html).toContain(m.space_setup_create_space());
  expect(html).toContain(m.space_setup_overview());
  expect(html).toContain(m.space_setup_not_saved());
  expect(html).not.toContain(m.space_setup_reference());
  expect(html).not.toContain(m.space_setup_create_realm());
  expect(html).not.toContain(m.space_setup_complete());
});

test('the actual unavailable or currently refused setup offers recovery without a writable fallback or a success claim', async () => {
  const { m } = await import('../src/paraglide/messages.js');
  const unavailable = await renderSetup({ kind: 'failure', reason: 'unavailable', status: 503 });
  expect(unavailable).toContain(m.space_setup_refresh());
  expect(unavailable).toContain('<fieldset disabled=""');
  expect(unavailable).not.toContain(m.space_setup_complete());
  const refused = await renderSetup({
    kind: 'ready',
    space: {
      id: spaceRecording.space.spaceId,
      head: spaceRecording.space.headRevisionId,
      title: spaceRecording.space.title,
      summary: spaceRecording.space.summary,
      address: null,
      realmId: null,
    },
    realm: null,
    permitted: empty.permitted,
  });
  expect(refused).toContain(m.space_setup_denied());
  expect(refused).toContain(spaceRecording.space.title);
  expect(refused).not.toContain(spaceRecording.space.spaceId);
  expect(refused).not.toContain('<input');
  expect(refused).not.toContain(m.space_setup_complete());
});
