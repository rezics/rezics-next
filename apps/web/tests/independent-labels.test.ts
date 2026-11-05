import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createLibraryLabelsFake } from '../src/kernel/fake/library-labels';
import { handleLabelForm, loadLabelsPage, submitLabel } from '../src/library/labels-read';
import { applySubjectLabelMutation, searchSubjectLabels } from '../src/library/subject-labels.ts';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadLabelShelfPage } = await import('../src/library/label-shelf-read');

const owner = '0192f3a0-6c1e-7b2a-9d4e-000000000111';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000222';
const canonicalId = '0192f3a0-6c1e-7b2a-9d4e-000000000223';
const assignmentId = '0192f3a0-6c1e-7b2a-9d4e-000000000333';
const sessionId = 'a'.repeat(43);
const csrf = 'A'.repeat(22);
const env = {
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.example.test',
  WEBSITE_SCOPES: 'library_entry:read library_entry:update library_entry:list progress_session:list',
  WEBSITE_CLIENT_ID: 'web-test',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: 'https://rezics.example.test',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', subject: owner, accessToken: 'owner-token', csrfToken: csrf }),
      signedIn: async () => ({ signedIn: true, csrfToken: csrf }),
    }),
  },
} as never;
function request(write = false) {
  return new Request('https://rezics.example.test/en/library/labels', {
    method: write ? 'POST' : 'GET',
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(write ? { origin: 'https://rezics.example.test', 'X-CSRF-Token': csrf } : {}),
    },
  });
}
const operations = ['personal_library', 'reading_progress', 'library_label.list', 'library_label.assignment_list'];

test('Independent labels work from catalogue to subject assignment and label shelf with exact Undo', async () => {
  const catalogue = createLibraryLabelsFake({ labels: [] });
  const calls: Request[] = [];
  let labelId = '';
  const fetcher: typeof fetch = async (input, init) => {
    const call = new Request(input, init);
    calls.push(call.clone());
    const url = new URL(call.url);
    if (url.pathname === '/v1/platform/exposure')
      return Response.json({ admitted: [...operations, ...catalogue.admitted] });
    if (url.pathname === '/v1/libraryLabelAssignments')
      return Response.json({
        label: catalogue.labels.find((label) => label.id === labelId),
        next: null,
        assignments: [
          {
            id: assignmentId,
            labelId,
            subjectId,
            revision: 17,
            subject: {
              id: canonicalId,
              type: 'schema:Thing',
              types: ['schema:Thing'],
              label: 'Unprofiled work',
              cover: null,
            },
            libraryEntry: null,
          },
        ],
      });
    if (url.pathname.endsWith(':unassign'))
      return Response.json(
        { deleted: true },
        {
          headers: { 'Library-Label-Assignment-Revision': '89' },
        },
      );
    if (url.pathname.endsWith(':assign') || url.pathname.endsWith(':restoreAssignment'))
      return Response.json({ assignment: { id: assignmentId, revision: 17 } });
    return catalogue.fetch(input, init);
  };
  const client = createKernelClient('https://kernel.example.test', { fetch: fetcher });
  expect(
    await submitLabel(client, request(true), env, {
      operation: 'create',
      name: '  Revisit\u00a0later  ',
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toEqual({ ok: true });
  const page = await loadLabelsPage(client, request(), env);
  const label = page.labels[0]!;
  labelId = label.id;
  expect(label.name).toBe('Revisit later');
  expect(
    await submitLabel(client, request(true), env, {
      operation: 'rename',
      id: label.id,
      name: 'Revisit',
      revision: label.revision,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toEqual({ ok: true });
  expect(
    await applySubjectLabelMutation(
      request(true),
      env,
      {
        intent: 'assign',
        subjectId,
        labelId,
        idempotencyKey: crypto.randomUUID(),
      },
      client,
    ),
  ).toMatchObject({ ok: true, assignment: { id: assignmentId, revision: 17 } });
  const shelf = await loadLabelShelfPage(client, request(), env, { labelId, limit: 100 });
  if (shelf.state !== 'loaded') throw new Error('Expected the FULL shelf');
  expect(shelf.entries[0]).toMatchObject({ id: assignmentId, subjectId, revision: 17, subject: { id: canonicalId } });
  expect(shelf.entries[0]).not.toHaveProperty('state');
  expect(shelf.entries[0]).not.toHaveProperty('activeProgressSession');
  const removeKey = shelf.entries[0]!.removeKey!;
  for (let replay = 0; replay < 2; replay++) {
    expect(
      await applySubjectLabelMutation(
        request(true),
        env,
        {
          intent: 'unassign',
          subjectId,
          labelId,
          assignmentId,
          revision: 17,
          idempotencyKey: removeKey,
        },
        client,
      ),
    ).toMatchObject({ ok: true, restoreRevision: 89 });
  }
  const beforeRestore = calls.length;
  const restoreKey = crypto.randomUUID();
  await applySubjectLabelMutation(
    request(true),
    env,
    {
      intent: 'restore',
      subjectId,
      labelId,
      assignmentId,
      revision: 89,
      idempotencyKey: restoreKey,
    },
    client,
  );
  expect(calls.slice(beforeRestore)).toHaveLength(1);
  expect(await calls.at(-1)!.json()).toEqual({ subjectId, assignmentId, revision: 89 });
  expect(calls.at(-1)!.headers.get('idempotency-key')).toBe(restoreKey);
  const current = catalogue.labels[0]!;
  const deleteKey = crypto.randomUUID();
  const deleted = await submitLabel(client, request(true), env, {
    operation: 'delete',
    id: labelId,
    revision: current.revision,
    idempotencyKey: deleteKey,
  });
  expect(deleted).toEqual({ ok: true, revision: 73 });
  const parentUndoStart = calls.length;
  await submitLabel(client, request(true), env, {
    operation: 'restore',
    id: labelId,
    revision: 73,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(calls.slice(parentUndoStart)).toHaveLength(1);
  expect(new URL(calls.at(-1)!.url).pathname).toBe(`/v1/libraryLabels/${labelId}:restore`);
  expect(
    await submitLabel(client, request(true), env, {
      operation: 'delete',
      id: labelId,
      revision: current.revision,
      idempotencyKey: deleteKey,
    }),
  ).toEqual(deleted);
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer owner-token')).toBe(true);
  expect(calls.some((call) => /libraryEntries|copies|progressSessions/.test(call.url))).toBe(false);
});

test('literal prefix continuation preserves the signed cursor and an empty page is distinct from failure', async () => {
  const calls: URL[] = [];
  let failure = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input) => {
      calls.push(new URL(String(input)));
      return failure
        ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
        : Response.json({ labels: [], next: 'signed+cursor/opaque' });
    },
  });
  const query = '  A\u0301\u00a0%_\\  ';
  expect(
    await searchSubjectLabels({ client, request: request(), sessionEnv: env, query, cursor: 'signed+cursor/opaque' }),
  ).toMatchObject({ state: 'loaded', labels: [], next: 'signed+cursor/opaque' });
  expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ q: query, limit: '20', cursor: 'signed+cursor/opaque' });
  failure = true;
  expect(await searchSubjectLabels({ client, request: request(), sessionEnv: env, query })).toMatchObject({
    state: 'unavailable',
    reason: 'dependency_unavailable',
  });
  expect(calls).toHaveLength(2);
});

test('catalogue and FULL shelf keep denied, preparation and unavailable responses separate from empty', async () => {
  for (const [status, code, catalogue, shelf] of [
    [403, 'forbidden', 'denied', 'denied'],
    [503, 'index_not_ready', 'preparing', 'preparing'],
    [503, 'dependency_unavailable', 'unavailable', 'preparing'],
  ] as const) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async (input) =>
        new URL(String(input)).pathname === '/v1/platform/exposure'
          ? Response.json({ admitted: operations })
          : Response.json({ code }, { status }),
    });
    expect(await loadLabelsPage(client, request(), env)).toMatchObject({ state: catalogue });
    expect(await loadLabelShelfPage(client, request(), env, { labelId: subjectId, limit: 100 })).toEqual({
      state: shelf,
    });
  }
});

test('a stale native catalogue reply retains the rendered Undo episode after the flash was consumed', async () => {
  const catalogue = createLibraryLabelsFake();
  catalogue.refuse('rename', 'conflict');
  const label = catalogue.labels[1]!;
  const key = crypto.randomUUID();
  const undoKey = crypto.randomUUID();
  const response = await handleLabelForm(
    createKernelClient('https://kernel.example.test', { fetch: catalogue.fetch }),
    new Request('https://rezics.example.test/en/library/labels?q=Winter&cursor=old', {
      method: 'POST',
      headers: {
        cookie: `__Host-rezics_session=${sessionId}`,
        origin: 'https://rezics.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        operation: 'rename',
        id: label.id,
        name: 'New name',
        library_label_revision: String(label.revision),
        idempotencyKey: key,
        csrf_token: csrf,
        undoId: catalogue.labels[0]!.id,
        undoName: 'Winter reads',
        undoRevision: '73',
        undoKey,
      }),
    }),
    env,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/en/library/labels?q=Winter');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const feedback = JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))).feedback;
  expect(feedback).toMatchObject({
    ok: false,
    reason: 'conflict',
    undoKey,
    undo: { id: catalogue.labels[0]!.id, name: 'Winter reads', revision: 73 },
  });
  expect(catalogue.calls).toHaveLength(1);
  expect(catalogue.calls[0]).toMatchObject({
    method: 'PATCH',
    key,
    body: { name: 'New name', revision: label.revision },
  });
});
