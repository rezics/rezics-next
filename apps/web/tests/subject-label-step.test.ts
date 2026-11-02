import { afterAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { subjectLabelStepForm } from '../src/library/subject-label-step-form';
import { m } from '../src/paraglide/messages.js';
import { applySubjectLabelMutation } from '../src/library/subject-labels';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const replacement = '0192f3a0-6c1e-7b2a-9d4e-000000000302';
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
const calls: { path: string; method: string; body: unknown; key: string | null; authorization: string | null }[] = [];
let found = false;
let lose: 'create' | 'assign' | null = null;
let closed = false;
let credential = 'original-token';
const kernel = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  calls.push({ path, method: request.method, body: await request.json().catch(() => null),
    key: request.headers.get('idempotency-key'), authorization: request.headers.get('authorization') });
  if (request.method === 'GET') return Response.json({ labels: found ? [{ id: replacement, name: 'Reading', revision: 1 }] : [], next: null });
  if (closed) return Response.json({ code: 'conflict' }, { status: 409 });
  const kind = path.endsWith(':assign') ? 'assign' : 'create';
  if (lose === kind) { lose = null; return new Response(null, { status: 503 }); }
  return kind === 'create' ? Response.json({ label: { id: labelId, revision: 1 } }, { status: 201 })
    : Response.json({ assignment: { id: labelId, revision: 1 } });
} });
afterAll(() => kernel.stop(true));
const client = createKernelClient(kernel.url.origin);
const env = {
  AUTH_ISSUER: 'https://auth.example.test', API_RESOURCE: 'https://api.example.test', WEBSITE_SCOPES: 'library_entry:update',
  WEBSITE_CLIENT_ID: 'web', WEBSITE_CLIENT_KEY: '{"private":"step-test-secret"}', SITE_ORIGINS: 'https://web.example.test',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential: async () => ({ status: 'active',
    accessToken: credential, subject: subjectId, csrfToken: csrf }) }) } as never,
};
const request = (token = csrf) => new Request('https://web.example.test/en/subjects/id/title', { method: 'POST', headers: {
  cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://web.example.test', 'X-CSRF-Token': token,
} });
const begin = () => applySubjectLabelMutation(request(), env, { intent: 'create-and-assign', subjectId, name: ' Reading ',
  createKey: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }, client);
function continuation(result: Awaited<ReturnType<typeof begin>>) {
  if (!('step' in result)) throw new Error('Expected a separate captured native step');
  return result.step;
}
const run = (step: ReturnType<typeof continuation>, token = csrf) => applySubjectLabelMutation(request(token), env,
  { intent: 'label-step', subjectId, token: step.token }, client);

test('lost create replays its command, and known create advances only to its exact assignment', async () => {
  calls.length = 0; found = false; credential = 'original-token';
  const create = continuation(await begin());
  expect(calls.map((call) => call.method)).toEqual(['GET']);
  lose = 'create';
  expect(await run(create)).toMatchObject({ ok: false, reason: 'unavailable' });
  const originalCreate = calls.at(-1);
  found = true; credential = 'renewed-token';
  const assign = continuation(await run(create));
  expect(assign).toMatchObject({ kind: 'assign', label: { id: labelId }, created: true });
  expect(calls.at(-1)).toEqual(originalCreate);
  expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  lose = 'assign';
  expect(await run(assign)).toMatchObject({ ok: false, reason: 'unavailable' });
  const originalAssign = calls.at(-1);
  expect(originalAssign).toMatchObject({ path: `/v1/libraryLabels/${labelId}:assign`, body: { subjectId }, authorization: 'Bearer original-token' });
  expect(await run(assign)).toMatchObject({ ok: true, assignment: { revision: 1 } });
  expect(calls.at(-1)).toEqual(originalAssign);
  expect(originalAssign?.key).not.toBe(originalCreate?.key);
});

test('exact-name selection captures identity before dispatch; refusal and missing admission cannot renew it', async () => {
  calls.length = 0; found = true; credential = 'original-token';
  const assign = continuation(await begin());
  expect(assign).toMatchObject({ kind: 'assign', label: { id: replacement }, created: false });
  found = false;
  const count = calls.length;
  expect(await run(assign, 'BBBBBBBBBBBBBBBBBBBBBB')).toMatchObject({ ok: false });
  expect(calls).toHaveLength(count);
  expect(await run({ ...assign, token: assign.token.slice(0, -8) + 'AAAAAAAA' })).toMatchObject({ ok: false });
  expect(calls).toHaveLength(count);
  closed = true;
  expect(await run(assign)).toMatchObject({ ok: false, reason: 'conflict' });
  expect(calls.at(-1)?.path).toBe(`/v1/libraryLabels/${replacement}:assign`);
  closed = false;
});


test('script-free continuation carries the actual returned ID and stable command, including on explicit retry', async () => {
  found = false; calls.length = 0;
  const create = continuation(await begin());
  const initial = await subjectLabelStepForm(request(), create, csrf).text();
  expect(initial).not.toContain('original-token');
  expect(initial).not.toContain('name="name"');
  const created = continuation(await run(create));
  const page = subjectLabelStepForm(request(), created, csrf);
  expect(page.headers.get('cache-control')).toBe('private, no-store');
  const html = await page.text();
  expect(html).toContain(m.library_subject_label_steps_created());
  const token = /name="token" value="([^"]+)"/.exec(html)![1]!;
  found = true; lose = 'assign';
  expect(await run({ ...created, token })).toMatchObject({ ok: false, reason: 'unavailable' });
  const retry = await subjectLabelStepForm(request(), { ...created, token }, csrf, true).text();
  expect(retry).toContain(`name="token" value="${token}"`);
  expect(retry).not.toContain('Reading');
  expect(await run({ ...created, token })).toMatchObject({ ok: true });
  expect(calls.slice(-2).map((call) => call.path)).toEqual(Array(2).fill(`/v1/libraryLabels/${labelId}:assign`));
});

test('missing create key does not dispatch; uniqueness refusal never selects a replacement', async () => {
  calls.length = 0; found = false;
  expect(await applySubjectLabelMutation(request(), env, { intent: 'create-and-assign', subjectId, name: 'Reading',
    idempotencyKey: crypto.randomUUID() }, client)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(0);
  const create = continuation(await begin());
  found = true; closed = true;
  expect(await run(create)).toMatchObject({ ok: false, reason: 'conflict' });
  expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  closed = false;
});
