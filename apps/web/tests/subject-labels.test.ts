import { afterAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubjectLabelNotice } from '../src/library/subject-labels.tsx';
import { loadSubjectLibrarySlot } from '../src/library/subject-slot';
import {
  applySubjectLabelMutation,
  normalizeLibraryLabelName,
  searchSubjectLabels,
} from '../src/library/subject-labels.ts';
import { m } from '../src/paraglide/messages.js';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const assignmentId = '0192f3a0-6c1e-7b2a-9d4e-000000000401';
const sessionId = 'a'.repeat(43);

type RequestCapture = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  key: string | null;
  authorization: string | null;
};

const requests: RequestCapture[] = [];
let assignments: { id: string; labelId: string; subjectId: string; revision: number; name: string }[] = [];
let assignmentRevision = 1;
let refuse: string | null = null;
let catalogueSize = 3;

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...Object.fromEntries(new Headers(headers)) },
  });

const fakeKernel = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body =
      request.method === 'GET'
        ? null
        : await request
            .clone()
            .json()
            .catch(() => null);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });

    if (url.pathname === '/v1/platform/exposure')
      return json({ admitted: ['personal_library', 'library_label.assignment_list'] });
    if (url.pathname === `/v1/subjects/${subjectId}/collections`) return json({ collections: [], next: null });
    if (url.pathname === `/v1/libraryEntries/${subjectId}`) return json({ code: 'not_found' }, 404);
    if (url.pathname === '/v1/libraryLabelAssignments' && request.method === 'GET') {
      const filteredLabelId = url.searchParams.get('labelId');
      if (filteredLabelId && filteredLabelId !== labelId) return json({ code: 'not_found' }, 404);
      return json({
        assignments: assignments.map(({ name, ...assignment }) => ({ ...assignment, label: { name } })),
        next: null,
        label: { id: labelId, name: 'Reading list', revision: 1 },
      });
    }
    if (url.pathname === '/v1/libraryLabels' && request.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const labels = Array.from({ length: Math.min(catalogueSize, 20) }, (_, index) => ({
        id: index === 0 ? labelId : `0192f3a0-6c1e-7b2a-9d4e-${String(700 + index).padStart(12, '0')}`,
        name: index === 0 ? 'Reading list' : `Read category ${index}`,
        revision: 1,
      })).filter((label) => label.name.startsWith(query));
      return json({ labels, next: null });
    }
    if (url.pathname === '/v1/libraryLabels' && request.method === 'POST') {
      return json({ label: { id: labelId, revision: 1 } }, 201);
    }
    const assignmentRoute = /^\/v1\/libraryLabels\/([^/]+):(assign|unassign|restoreAssignment)$/.exec(url.pathname);
    if (assignmentRoute && request.method === 'POST') {
      const action = assignmentRoute[2];
      if (refuse) {
        const code = refuse;
        refuse = null;
        return json(
          { code },
          409,
          action === 'unassign' ? { 'Library-Label-Assignment-Revision': String(assignmentRevision + 1) } : {},
        );
      }
      if (action === 'assign') return json({ assignment: { id: assignmentId, revision: assignmentRevision } });
      if (action === 'unassign') {
        assignmentRevision += 1;
        return json({ deleted: true }, 200, { 'Library-Label-Assignment-Revision': String(assignmentRevision) });
      }
      assignmentRevision += 1;
      return json({ assignment: { id: assignmentId, revision: assignmentRevision } });
    }
    return json({ code: 'not_found' }, 404);
  },
});

function sessionEnv() {
  const credential = {
    status: 'active',
    subject: accountId,
    accessToken: 'native-web-token',
    csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
  };
  return {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'library_entry:read library_entry:update library_entry:list',
    WEBSITE_CLIENT_ID: 'rezics-web-test',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://rezics.example.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => credential,
        signedIn: async () => ({ signedIn: true, csrfToken: credential.csrfToken }),
      }),
    },
  } as never;
}

function viewerRequest(signedIn = true) {
  return new Request('https://rezics.example.test/en/subjects/example', {
    headers: signedIn ? { cookie: `__Host-rezics_session=${sessionId}` } : {},
  });
}

function mutationRequest() {
  return new Request('https://rezics.example.test/en/subjects/example', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      origin: 'https://rezics.example.test',
      'X-CSRF-Token': 'AAAAAAAAAAAAAAAAAAAAAA',
    },
  });
}

function reset(rows: typeof assignments = []) {
  requests.length = 0;
  assignments = rows;
  assignmentRevision = 1;
  refuse = null;
  catalogueSize = 3;
}

const client = () => createKernelClient(fakeKernel.url.origin);

afterAll(() => fakeKernel.stop(true));

test('label names use the documented NFC and Unicode whitespace rule without case folding', () => {
  expect(normalizeLibraryLabelName('  Wa\u0301nt\u00a0to\tread  ')).toBe('Wánt to read');
  expect(normalizeLibraryLabelName('Want to read')).not.toBe(normalizeLibraryLabelName('want to read'));
});

test('the subject slot reads one FULL assignment page for its owner in kernel order and no assignment page for a signed-out reader', async () => {
  for (const count of [0, 3, 32]) {
    reset(
      Array.from({ length: count }, (_, index) => ({
        id: `0192f3a0-6c1e-7b2a-9d4e-${String(500 + index).padStart(12, '0')}`,
        labelId: `0192f3a0-6c1e-7b2a-9d4e-${String(600 + index).padStart(12, '0')}`,
        subjectId,
        revision: 1,
        name: `Label ${String(32 - index).padStart(2, '0')}`,
      })),
    );
    const slot = await loadSubjectLibrarySlot(client() as never, viewerRequest(), sessionEnv(), subjectId);
    expect(slot.session).toBe('signed-in');
    expect(slot.labels?.map((label) => label.name)).toEqual(assignments.map((label) => label.name));
    const reads = requests.filter((request) => request.path === '/v1/libraryLabelAssignments');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      method: 'GET',
      query: { subjectId, view: 'FULL', limit: '32' },
      authorization: 'Bearer native-web-token',
    });
  }

  reset([{ id: assignmentId, labelId, subjectId, revision: 1, name: 'Private name' }]);
  const anonymous = await loadSubjectLibrarySlot(client() as never, viewerRequest(false), sessionEnv(), subjectId);
  expect(anonymous.session).toBe('signed-out');
  expect(JSON.stringify(anonymous)).not.toContain('Private name');
  expect(requests.some((request) => request.path === '/v1/libraryLabelAssignments')).toBe(false);
});

test('a settled picker search uses the literal typed prefix and one bounded catalogue read', async () => {
  reset();
  catalogueSize = 1;
  const result = await searchSubjectLabels({
    client: client() as never,
    request: viewerRequest(),
    sessionEnv: sessionEnv(),
    query: 'Read',
  });
  expect(result.labels).toEqual([{ id: labelId, name: 'Reading list', revision: 1 }]);
  expect(requests.filter((request) => request.path === '/v1/libraryLabels')).toEqual([
    expect.objectContaining({
      method: 'GET',
      query: { q: 'Read', limit: '20' },
      authorization: 'Bearer native-web-token',
    }),
  ]);
});

test('catalogue search makes one bounded read with three or five hundred labels', async () => {
  for (const count of [3, 500]) {
    reset();
    catalogueSize = count;
    const result = await searchSubjectLabels({
      client: client() as never,
      request: viewerRequest(),
      sessionEnv: sessionEnv(),
      query: 'Read',
    });
    expect(result.labels.length).toBe(Math.min(count, 20));
    expect(requests.filter((request) => request.path === '/v1/libraryLabels')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/v1/libraryLabels')[0]).toMatchObject({
      method: 'GET',
      query: { q: 'Read', limit: '20' },
    });
  }
});

test('Subject create-and-assign refuses normalized native failures before any catalogue or command request', async () => {
  for (const name of ['', ' \t\u2003 ', '📚'.repeat(101), 'A\u0000B', 'A\ud800', '\udc00B']) {
    reset();
    const result = await applySubjectLabelMutation(
      mutationRequest(),
      sessionEnv(),
      {
        intent: 'create-and-assign',
        subjectId,
        name,
        idempotencyKey: crypto.randomUUID(),
      },
      client() as never,
    );
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  }
});

test('assign, unassign and restore use one idempotent write and the server-provided undo revision', async () => {
  reset();
  const assignKey = crypto.randomUUID();
  const assigned = await applySubjectLabelMutation(
    mutationRequest(),
    sessionEnv(),
    {
      intent: 'assign',
      subjectId,
      labelId,
      idempotencyKey: assignKey,
    },
    client() as never,
  );
  expect(assigned).toMatchObject({ ok: true, assignment: { id: assignmentId, revision: 1 } });
  expect(requests.at(-1)).toMatchObject({
    method: 'POST',
    path: `/v1/libraryLabels/${labelId}:assign`,
    body: { subjectId },
    key: assignKey,
    authorization: 'Bearer native-web-token',
  });

  requests.length = 0;
  assignmentRevision = 70;
  const removed = await applySubjectLabelMutation(
    mutationRequest(),
    sessionEnv(),
    {
      intent: 'unassign',
      subjectId,
      labelId,
      assignmentId,
      revision: 1,
      idempotencyKey: crypto.randomUUID(),
    },
    client() as never,
  );
  expect(removed).toMatchObject({ ok: true, restoreRevision: 71 });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'POST',
    path: `/v1/libraryLabels/${labelId}:unassign`,
    body: { subjectId, assignmentId, revision: 1 },
  });

  requests.length = 0;
  const restored = await applySubjectLabelMutation(
    mutationRequest(),
    sessionEnv(),
    {
      intent: 'restore',
      subjectId,
      labelId,
      assignmentId,
      revision: removed.ok && 'restoreRevision' in removed ? removed.restoreRevision! : 0,
      idempotencyKey: crypto.randomUUID(),
    },
    client() as never,
  );
  expect(restored).toMatchObject({ ok: true, assignment: { id: assignmentId, revision: 72 } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'POST',
    path: `/v1/libraryLabels/${labelId}:restoreAssignment`,
    body: { subjectId, assignmentId, revision: 71 },
  });
});

test('a new label prepares separate creation and assignment steps with distinct idempotency keys', async () => {
  reset();
  const createKey = crypto.randomUUID();
  const assignKey = crypto.randomUUID();
  let result = await applySubjectLabelMutation(
    mutationRequest(),
    sessionEnv(),
    {
      intent: 'create-and-assign',
      subjectId,
      name: 'New reading list',
      createKey,
      idempotencyKey: assignKey,
    },
    client() as never,
  );
  expect(result).toMatchObject({ ok: false, reason: 'continue', step: { kind: 'create' } });
  expect(requests).toHaveLength(1);
  for (let index = 0; index < 2; index++) {
    if (!('step' in result)) throw new Error('Expected the next native command');
    result = await applySubjectLabelMutation(mutationRequest(), sessionEnv(), {
      intent: 'label-step', subjectId, token: result.step.token,
    }, client() as never);
    if (index === 0) expect(result).toMatchObject({ ok: false, reason: 'continue', step: { created: true, label: { id: labelId } } });
  }
  expect(result).toMatchObject({
    ok: true,
    label: { id: labelId, name: 'New reading list' },
    assignment: { id: assignmentId, revision: 1 },
  });
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /v1/libraryLabels',
    'POST /v1/libraryLabels',
    `POST /v1/libraryLabels/${labelId}:assign`,
  ]);
  expect(requests[0]).toMatchObject({ query: { q: 'New reading list', limit: '20' } });
  expect(requests[1]).toMatchObject({ body: { name: 'New reading list' }, key: createKey });
  expect(requests[2]).toMatchObject({ body: { subjectId }, key: assignKey });
});

test('capacity and each restore refusal remain distinct mutation results', async () => {
  const results: [string, string][] = [
    ['library_label_capacity', 'capacity'],
    ['library_label_restore_stale', 'restore-stale'],
    ['library_label_restore_expired', 'restore-expired'],
    ['library_label_restore_occupied', 'restore-occupied'],
    ['library_label_restore_capacity', 'restore-capacity'],
  ];
  const labelsByReason: Record<string, () => string> = {
    capacity: m.library_subject_label_capacity,
    'restore-stale': m.library_subject_label_restore_stale,
    'restore-expired': m.library_subject_label_restore_expired,
    'restore-occupied': m.library_subject_label_restore_occupied,
    'restore-capacity': m.library_subject_label_restore_capacity,
  };
  for (const [code, expected] of results) {
    reset();
    refuse = code;
    const action = code === 'library_label_capacity' ? 'assign' : 'restore';
    const result = await applySubjectLabelMutation(
      mutationRequest(),
      sessionEnv(),
      {
        intent: action,
        subjectId,
        labelId,
        assignmentId,
        revision: 2,
        idempotencyKey: crypto.randomUUID(),
      },
      client() as never,
    );
    expect(result).toMatchObject({ ok: false, reason: expected });
    const notice = renderToStaticMarkup(
      createElement(SubjectLabelNotice, {
        result: code === 'library_label_capacity' ? 'label-capacity' : `label-${expected}`,
      }),
    );
    expect(notice).toContain(labelsByReason[expected]!());
    expect(notice).toContain('role="alert"');
  }
});

test('a capacity refusal leaves the assignment rows shown in the subject slot unchanged', async () => {
  const starting = [{ id: assignmentId, labelId, subjectId, revision: 1, name: 'Reading list' }];
  reset(starting);
  refuse = 'library_label_capacity';
  const result = await applySubjectLabelMutation(
    mutationRequest(),
    sessionEnv(),
    {
      intent: 'assign',
      subjectId,
      labelId: '0192f3a0-6c1e-7b2a-9d4e-000000000333',
      idempotencyKey: crypto.randomUUID(),
    },
    client() as never,
  );
  expect(result).toEqual({ ok: false, reason: 'capacity' });
  const slot = await loadSubjectLibrarySlot(client() as never, viewerRequest(), sessionEnv(), subjectId);
  expect(slot.labels).toEqual([{ id: assignmentId, labelId, name: 'Reading list', revision: 1 }]);
});
