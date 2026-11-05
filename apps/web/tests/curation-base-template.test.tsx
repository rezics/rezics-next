import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  PROFILE_FORMAT,
  profileDigest,
  resolveTemplate,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import { addStructuralBaseTemplate } from '../src/features/pages/curation-base-template';
import { publishProfile } from '../src/features/pages/curate';

const document: CompositionDocument = { root: { props: {} }, content: [] };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: document,
  bases: [{ base: 'schema:CreativeWork', document }],
  types: [{ type: 'schema:Book', document }],
  routes: [{ route: '/', document }],
};

test('structural bases insert once, preserve other templates, resolve as fallback, and publish normally', async () => {
  const before = structuredClone(profile);
  expect(addStructuralBaseTemplate(profile, 'schema:CreativeWork')).toEqual({
    ok: false,
    errors: [{ pointer: '/bases', code: 'duplicate' }],
  });
  const invalid = addStructuralBaseTemplate(profile, 'not a CURIE');
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid CURIE was accepted');
  expect(invalid.errors).toContainEqual({ pointer: '/bases/0/base', code: 'invalid' });

  const addition = addStructuralBaseTemplate(profile, 'schema:Article');
  expect(addition.ok).toBe(true);
  if (!addition.ok) throw new Error('structural base was rejected');
  expect(addition.profile.bases.map(({ base }) => base)).toEqual(['schema:Article', 'schema:CreativeWork']);
  expect(addition.profile.types).toEqual(profile.types);
  expect(addition.profile.routes).toEqual(profile.routes);
  expect([
    resolveTemplate(addition.profile, { route: '/', type: 'schema:Book', bases: ['schema:Article'] }).scope,
    resolveTemplate(addition.profile, { type: 'schema:Book', bases: ['schema:Article'] }).scope,
    resolveTemplate(addition.profile, { bases: ['schema:Article'] }).scope,
  ]).toEqual(['route', 'type', 'base']);

  const digest = profileDigest(addition.profile);
  const requests: { path: string; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = decodeURIComponent(new URL(request.url).pathname);
      requests.push({ path, body: await request.json() });
      const activation = path.endsWith(':activate');
      return Response.json(activation ? { digest, head: 8 } : { digest }, { status: activation ? 200 : 201 });
    },
  });
  expect(
    await publishProfile(client, {
      profile: addition.profile,
      expectedHead: 7,
      authorization: 'Bearer token',
      keys: { publish: '0192f3a0-6c1e-7b2a-9d4e-000000000001', activate: '0192f3a0-6c1e-7b2a-9d4e-000000000002' },
    }),
  ).toEqual({ ok: true, digest, head: 8 });
  expect(requests).toEqual([
    { path: '/v1/presentation/profiles', body: { profile: addition.profile } },
    { path: `/v1/presentation/profiles/${digest}:activate`, body: { expected_head: 7 } },
  ]);
  expect(profile).toEqual(before);
});
