import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { profileTemplates, publishProfile, withTemplate } from '../src/features/pages/curate.ts';

const doc = (id: string) =>
  ({ root: { props: {} }, content: [{ type: 'Text', props: { id, text: { en: id } } }] }) as CompositionDocument;
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: doc('generic'),
  bases: [{ base: 'schema:CreativeWork', document: doc('work') }],
  types: [
    { type: 'schema:Book', document: doc('book') },
    { type: 'schema:Recipe', document: doc('recipe') },
  ],
  routes: [{ route: '/', document: doc('home') }],
};
const keys = { publish: '0192f3a0-6c1e-7b2a-9d4e-000000000001', activate: '0192f3a0-6c1e-7b2a-9d4e-000000000002' };

type Seen = { method: string; path: string; authorization: string | null; key: string | null; body: unknown };
function kernel(answers: Response[]) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const text = await request.text();
    seen.push({
      method: request.method,
      path: decodeURIComponent(new URL(request.url).pathname),
      authorization: request.headers.get('authorization'),
      key: request.headers.get('idempotency-key'),
      body: text ? JSON.parse(text) : null,
    });
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected request');
    return answer;
  }) as typeof globalThis.fetch;
  return { seen, client: createKernelClient('https://kernel.invalid', { fetch }) };
}
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  answer(status, { type: 'about:blank', title: code, status, code, ...extra });

test('a curator sees every template of the active profile', () => {
  expect(profileTemplates(profile)).toEqual([
    { scope: 'generic', key: null },
    { scope: 'base', key: 'schema:CreativeWork' },
    { scope: 'type', key: 'schema:Book' },
    { scope: 'type', key: 'schema:Recipe' },
    { scope: 'route', key: '/' },
  ]);
});

test('editing a template replaces or inserts it in order and never mutates the profile', () => {
  const before = structuredClone(profile);
  const added = withTemplate(profile, { scope: 'type', key: 'schema:Movie' }, doc('movie'));
  expect(added.types).toEqual([
    { type: 'schema:Book', document: doc('book') },
    { type: 'schema:Movie', document: doc('movie') },
    { type: 'schema:Recipe', document: doc('recipe') },
  ]);
  expect(withTemplate(profile, { scope: 'route', key: '/' }, doc('home2')).routes).toEqual([
    { route: '/', document: doc('home2') },
  ]);
  expect(
    withTemplate(profile, { scope: 'route', key: '/books' }, doc('books')).routes.map(({ route }) => route),
  ).toEqual(['/', '/books']);
  expect(withTemplate(profile, { scope: 'generic', key: null }, doc('generic2')).generic).toEqual(doc('generic2'));
  expect(withTemplate(profile, { scope: 'base', key: 'schema:CreativeWork' }, doc('work2')).bases).toEqual([
    { base: 'schema:CreativeWork', document: doc('work2') },
  ]);
  expect(profile).toEqual(before);
});

test('publishing sends the profile, then activates it at the head the curator loaded', async () => {
  const edited = withTemplate(profile, { scope: 'type', key: 'schema:Movie' }, doc('movie'));
  const digest = profileDigest(edited);
  const { seen, client } = kernel([answer(201, { digest }), answer(200, { digest, head: 8 })]);
  const result = await publishProfile(client, { profile: edited, expectedHead: 7, authorization: 'Bearer t', keys });
  expect(result).toEqual({ ok: true, digest, head: 8 });
  expect(seen).toEqual([
    {
      method: 'POST',
      path: '/v1/presentation/profiles',
      authorization: 'Bearer t',
      key: keys.publish,
      body: { profile: edited },
    },
    {
      method: 'POST',
      path: `/v1/presentation/profiles/${digest}:activate`,
      authorization: 'Bearer t',
      key: keys.activate,
      body: { expected_head: 7 },
    },
  ]);
});

test('a stale head, an invalid profile and a refusal come back as reasons', async () => {
  const digest = profileDigest(profile);
  const run = async (answers: Response[]) => {
    const { seen, client } = kernel(answers);
    const result = await publishProfile(client, { profile, expectedHead: 7, authorization: 'Bearer t', keys });
    return { result, requests: seen.length };
  };
  expect(await run([answer(200, { digest }), problem(409, 'stale_editorial_head')])).toEqual({
    result: { ok: false, reason: 'stale' },
    requests: 2,
  });
  const errors = [{ pointer: '/profile/generic/content/0/type', code: 'unsupported' }];
  expect(await run([problem(400, 'invalid_request', { errors })])).toEqual({
    result: { ok: false, reason: 'invalid', errors },
    requests: 1,
  });
  expect(await run([problem(403, 'forbidden')])).toEqual({ result: { ok: false, reason: 'forbidden' }, requests: 1 });
  expect(await run([answer(201, { digest }), problem(403, 'forbidden')])).toEqual({
    result: { ok: false, reason: 'forbidden' },
    requests: 2,
  });
  expect(await run([problem(429, 'rate_limited')])).toEqual({
    result: { ok: false, reason: 'rate-limited' },
    requests: 1,
  });
  const limited = kernel([new Response(null, { status: 429, headers: { 'retry-after': '30' } })]);
  expect(await publishProfile(limited.client, { profile, expectedHead: 7, authorization: 'Bearer t', keys })).toEqual({
    ok: false,
    reason: 'rate-limited',
    retryAfter: 30,
  });
  expect(await run([problem(503, 'unavailable')])).toEqual({
    result: { ok: false, reason: 'unavailable' },
    requests: 1,
  });
});

test('the curation route is mounted and its scopes are documented', async () => {
  const route = await Bun.file(new URL('../src/routes/curate/presentation.tsx', import.meta.url)).text();
  expect(route).toContain("createFileRoute('/curate/presentation')");
  const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
  expect(readme).toContain('presentation:publish');
  expect(readme).toContain('presentation:activate');
});
