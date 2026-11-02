import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { publishProfile } from '../src/features/pages/curate';
import { admittedActivationResult, admittedPublishDigest } from '../src/features/pages/curation-publication-response';
import { CurationPublication } from '../src/features/pages/curation-publish';

const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};
const digest = profileDigest(profile);
const foreign = `sha256:${'b'.repeat(64)}`;
const keys = { publish: '0192f3a0-6c1e-7b2a-9d4e-000000000001', activate: '0192f3a0-6c1e-7b2a-9d4e-000000000002' };
const unknownPublish = { ok: false, reason: 'unavailable', outcome: 'unknown', phase: 'publish' } as const;
const unknownActivate = { ok: false, reason: 'unavailable', outcome: 'unknown', phase: 'activate' } as const;

function kernel(answers: Response[]) {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push(decodeURIComponent(new URL(request.url).pathname));
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected request');
    return answer;
  }) as typeof globalThis.fetch;
  return { seen, client: createKernelClient('https://kernel.invalid', { fetch }) };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const publish = (client: ReturnType<typeof kernel>['client']) =>
  publishProfile(client, { profile, expectedHead: 7, authorization: 'Bearer t', keys });

test('native envelopes admit only the submitted digest and a nonnegative head', () => {
  expect(admittedPublishDigest({ digest, extra: true }, digest)).toBe(digest);
  expect(admittedActivationResult({ digest, head: 0, extra: true }, digest)).toEqual({ digest, head: 0 });
  expect(admittedPublishDigest({ digest: foreign }, digest)).toBeUndefined();
  expect(admittedPublishDigest({ digest: 'digest' }, digest)).toBeUndefined();
  expect(admittedActivationResult({ digest, head: -1 }, digest)).toBeUndefined();
  expect(admittedActivationResult({ digest }, digest)).toBeUndefined();
});

test('a matching first attempt or replay activates the submitted digest and constructs success', async () => {
  for (const [status, head] of [
    [201, 8],
    [200, 0],
  ] as const) {
    const { seen, client } = kernel([json(status, { digest, extra: 1 }), json(200, { digest, head, extra: 1 })]);
    expect(await publish(client)).toEqual({ ok: true, digest, head });
    expect(seen).toEqual(['/v1/presentation/profiles', `/v1/presentation/profiles/${digest}:activate`]);
  }
});

test('a malformed or foreign publish envelope does not activate', async () => {
  for (const body of [{}, { digest: 'digest' }, { digest: foreign }]) {
    const { seen, client } = kernel([json(201, body)]);
    expect(await publish(client)).toEqual(unknownPublish);
    expect(seen).toEqual(['/v1/presentation/profiles']);
  }
});

test('a malformed or foreign activate envelope keeps the activate phase unknown', async () => {
  for (const body of [{ digest }, { digest, head: -1 }, { digest: foreign, head: 8 }]) {
    const { seen, client } = kernel([json(201, { digest }), json(200, body)]);
    expect(await publish(client)).toEqual(unknownActivate);
    expect(seen).toEqual(['/v1/presentation/profiles', `/v1/presentation/profiles/${digest}:activate`]);
  }
});

test('an unknown publication result retains the original intent', async () => {
  const { client } = kernel([json(201, { digest: foreign })]);
  const publication = new CurationPublication('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', {
    publish: (input) => publishProfile(client, { ...input, authorization: 'Bearer t' }),
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  expect(await publication.start(profile, 7)).toBeNull();
  const { intent, result } = publication.getSnapshot();
  expect(intent?.profile).toEqual(profile);
  expect(intent?.expectedHead).toBe(7);
  expect(result).toEqual(unknownPublish);
  expect(publication.getSnapshot().intent).toBe(intent);
});
