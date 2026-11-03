import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import definitions from '../../src/kernel/recorded/definitions-release.json';
import { createConceptSubject } from '../../src/features/catalogue/concept-create';
import type { SessionEnv } from '../../src/session/client';

mock.module('cloudflare:workers', () => ({ env: {} }));

const createdId = '00000000-0000-4000-8000-00000000c301';

test('native Concept create posts once, retries only readback, and returns the exact identity', async () => {
  const calls: { method: string; path: string; key: string | null }[] = [];
  let lost = false;
  const item = {
    type: 'skos:Concept',
    labels: { en: 'Night', ja: '夜' },
    descriptions: { en: 'A time of day' },
    statements: {
      'skos:inScheme': [
        {
          property: { id: 'skos:inScheme' },
          value: { type: 'value', content: '00000000-0000-4000-8000-00000000c102' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      ],
    },
  };
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      calls.push({ method: request.method, path, key: request.headers.get('idempotency-key') });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (request.method === 'GET' && path === '/v1/definitions/active') return json({ digest: definitions.digest });
      if (request.method === 'GET' && path === `/v1/definitions/releases/${definitions.digest}`)
        return json({ digest: definitions.digest, release: definitions.release });
      if (request.method === 'POST' && path === '/v1/subjects') {
        if (!lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json({ subject: { id: createdId, type: item.type, labels: item.labels } }, 201);
      }
      if (request.method === 'GET' && path === `/v1/subjects/${createdId}`)
        return json({
          subject: {
            id: createdId,
            type: item.type,
            labels: item.labels,
            descriptions: item.descriptions,
            aliases: {},
            statements: {},
            revision: 1,
            release: definitions.digest,
            context: '00000000-0000-8000-8000-000000000000',
            resolution: {},
            relationCounts: {},
            sourceRecords: [],
          },
          account: null,
          summary: null,
          related: {},
        });
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const request = new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'X-CSRF-Token': 'A'.repeat(22),
    },
  });
  const env = { AUTH_ISSUER: 'https://auth.invalid' } as Partial<SessionEnv>;
  const key = crypto.randomUUID();
  const first = await createConceptSubject(client, request, env, { key, item }, 'en', 'Bearer token');
  expect(first).toMatchObject({ ok: false, reason: 'unavailable' });
  const second = await createConceptSubject(client, request, env, { key, item }, 'en', 'Bearer token');
  expect(second).toMatchObject({
    ok: true,
    id: createdId,
    reader: { state: 'ready' },
  });
  expect(
    calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects').map((call) => call.key),
  ).toEqual([key, key]);
});
