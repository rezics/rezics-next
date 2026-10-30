import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { publishProfile, withTemplate, type CurationFailure, type PublishInput } from '../src/features/pages/curate';
import { CurationPublication, type ActiveCuration } from '../src/features/pages/curation-publish';

const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
});
const changed = (draft: PresentationProfile) =>
  withTemplate(
    draft,
    { scope: 'route', key: '/books' },
    {
      root: { props: {} },
      content: [{ type: 'Text', props: { id: 'books', text: { en: 'Draft books' } } }],
    },
  );
const response = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
type Loss = 'publish-response' | 'activate-before' | 'activate-response' | 'none';

// Wire fixture only: the generated SDK and product publish helper run unchanged.
// Native authorization/receipt proof remains with the existing kernel acceptance.
function wire(loss: Loss) {
  let head = 7;
  let activeProfile = profile();
  let granted = true;
  let lose = loss;
  const seen: { path: string; body: unknown; key: string | null; authorization: string | null }[] = [];
  const receipts = new Map<string, { body: string; result: unknown }>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    const body = (await request.json()) as Record<string, unknown>;
    const key = request.headers.get('idempotency-key');
    seen.push({ path, body, key, authorization: request.headers.get('authorization') });
    if (!granted) return response(403, { code: 'forbidden' });
    const previous = receipts.get(key!);
    if (previous) {
      if (previous.body !== JSON.stringify(body)) return response(422, { code: 'idempotency_conflict' });
      return response(200, previous.result);
    }
    if (path === '/v1/presentation/profiles') {
      const result = { digest: profileDigest(body.profile as PresentationProfile) };
      receipts.set(key!, { body: JSON.stringify(body), result });
      if (lose === 'publish-response') {
        lose = 'none';
        throw new TypeError('connection lost after publish');
      }
      return response(201, result);
    }
    if (lose === 'activate-before') {
      lose = 'none';
      throw new TypeError('connection lost before activation');
    }
    if (body.expected_head !== head) return response(409, { code: 'stale_editorial_head' });
    const digest = path.slice('/v1/presentation/profiles/'.length, -':activate'.length);
    const result = { digest, head: ++head };
    const published = seen.find((entry) => entry.path === '/v1/presentation/profiles')!.body as {
      profile: PresentationProfile;
    };
    activeProfile = published.profile;
    receipts.set(key!, { body: JSON.stringify(body), result });
    if (lose === 'activate-response') {
      lose = 'none';
      throw new TypeError('connection lost after activation');
    }
    return response(200, result);
  }) as typeof globalThis.fetch;
  const client = createKernelClient('https://kernel.invalid', { fetch });
  const transport = {
    publish: (input: PublishInput) => publishProfile(client, { ...input, authorization: 'Bearer current-session' }),
    read: async (): Promise<ActiveCuration> => ({
      ok: true,
      head,
      digest: profileDigest(activeProfile),
      profile: activeProfile,
    }),
  };
  return {
    seen,
    receipts,
    transport,
    revoke: () => {
      granted = false;
    },
    restore: () => {
      granted = true;
    },
    moveHead: () => {
      head = 9;
      activeProfile = changed(profile());
    },
  };
}

test('the actual immutable profile publish-and-activate flow resolves unknown outcomes with stable original operation keys and preserves drafts during current-head conflicts', async () => {
  for (const loss of ['publish-response', 'activate-before', 'activate-response'] as const) {
    const native = wire(loss);
    const publication = new CurationPublication(native.transport);
    const draft = profile();
    expect(await publication.start(draft, 7)).toBeNull();
    const original = publication.getSnapshot().intent!;
    expect(publication.getSnapshot().result).toMatchObject({ ok: false, reason: 'unavailable', outcome: 'unknown' });
    expect(Object.isFrozen(original.profile.generic)).toBe(true);
    expect(original.keys.publish).not.toBe(original.keys.activate);

    // A later editor change cannot replace the pending body or allocate another operation.
    const laterDraft = changed(draft);
    const requests = native.seen.length;
    expect(await publication.start(laterDraft, 9)).toBeNull();
    expect(native.seen).toHaveLength(requests);
    expect(publication.getSnapshot().intent).toBe(original);
    expect(original.profile).toEqual(profile());
    const confirmed = await publication.retry();
    expect(confirmed).toEqual({ intent: original, result: { ok: true, digest: profileDigest(profile()), head: 8 } });
    expect(laterDraft.routes[0]?.route).toBe('/books');
    expect(native.receipts.size).toBe(2);
    for (const request of native.seen) {
      expect(request.authorization).toBe('Bearer current-session');
      if (request.path === '/v1/presentation/profiles') {
        expect(request.key).toBe(original.keys.publish);
        expect(request.body).toEqual({ profile: original.profile });
      } else {
        expect(request.path).toBe(`/v1/presentation/profiles/${profileDigest(original.profile)}:activate`);
        expect(request.key).toBe(original.keys.activate);
        expect(request.body).toEqual({ expected_head: 7 });
      }
    }
  }

  for (const choice of ['keep', 'discard'] as const) {
    const native = wire('none');
    native.moveHead();
    const publication = new CurationPublication(native.transport);
    const draft = profile();
    expect(await publication.start(draft, 7)).toBeNull();
    const pending = publication.getSnapshot().intent!;
    expect(publication.getSnapshot().result).toEqual({ ok: false, reason: 'stale' });
    expect(publication.getSnapshot().active?.head).toBe(9);
    expect(draft).toEqual(profile());
    expect(publication.getSnapshot().intent?.profile).toEqual(draft);
    const reviewed = publication.reconcile(draft, choice)!;
    expect(reviewed.head).toBe(9);
    expect(reviewed.profile).toEqual(choice === 'keep' ? draft : changed(profile()));
    expect(publication.getSnapshot().intent).toBeNull();
    await publication.start(reviewed.profile, reviewed.head);
    expect(native.seen.at(-2)?.key).not.toBe(pending.keys.publish);
    expect(native.seen.at(-1)?.key).not.toBe(pending.keys.activate);
    expect(native.seen.at(-1)?.body).toEqual({ expected_head: 9 });
  }
});

test('revocation after an ambiguous activation is checked on replay before any receipt can complete the intent', async () => {
  const native = wire('activate-response');
  const publication = new CurationPublication(native.transport);
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent;
  native.revoke();
  expect(await publication.retry()).toBeNull();
  expect(publication.getSnapshot().result).toEqual({ ok: false, reason: 'forbidden' });
  expect(publication.getSnapshot().intent).toBe(original);
  expect(native.seen.at(-1)?.path).toBe('/v1/presentation/profiles');
  expect(native.seen.at(-1)?.key).toBe(original?.keys.publish);
  native.restore();
  expect((await publication.retry())?.result.head).toBe(8);
  expect(native.receipts.size).toBe(2);
});

test('an active read, even matching an uncertain activation, never invents confirmation or permits a new intent', async () => {
  const native = wire('activate-response');
  const publication = new CurationPublication(native.transport);
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent;
  await publication.inspect();
  expect(publication.getSnapshot().active).toMatchObject({ head: 8, digest: profileDigest(profile()) });
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, outcome: 'unknown' });
  expect(publication.reconcile(changed(profile()), 'keep')).toBeNull();
  expect(publication.getSnapshot().intent).toBe(original);
  expect(await publication.start(changed(profile()), 8)).toBeNull();
});

test('typed validation, rate limits and unavailability retain the original intent and exact draft', async () => {
  const failures: CurationFailure[] = [
    { ok: false, reason: 'invalid', errors: [{ pointer: '/types/0/views/overview/content', code: 'out_of_range' }] },
    { ok: false, reason: 'rate-limited', retryAfter: 30 },
    { ok: false, reason: 'unavailable' },
  ];
  for (const failure of failures) {
    const seen: PublishInput[] = [];
    const publication = new CurationPublication({
      publish: async (input) => {
        seen.push(input);
        return structuredClone(failure);
      },
      read: async () => {
        throw new TypeError('read unavailable');
      },
    });
    const draft = profile();
    await publication.start(draft, 7);
    const original = publication.getSnapshot().intent;
    await publication.inspect();
    expect(publication.getSnapshot().readFailure).toEqual({ ok: false, reason: 'unavailable' });
    await publication.retry();
    expect(seen).toEqual([original!, original!]);
    expect(draft).toEqual(profile());
    expect(publication.getSnapshot().intent).toBe(original);
    expect(publication.getSnapshot().result).toEqual(failure);
  }
});

test('a revised invalid draft starts only by explicit replacement, with fresh keys and whole-profile validation', async () => {
  const seen: PublishInput[] = [];
  const publication = new CurationPublication({
    publish: async (input) => {
      seen.push(input);
      return { ok: false, reason: 'invalid', errors: [{ pointer: '/generic', code: 'invalid_format' }] };
    },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent!;
  await publication.start(changed(profile()), 7);
  expect(seen).toHaveLength(1);
  await publication.replaceInvalid(changed(profile()), 7);
  const revised = publication.getSnapshot().intent!;
  expect(revised.keys.publish).not.toBe(original.keys.publish);
  expect(revised.keys.activate).not.toBe(original.keys.activate);
  expect(revised.profile).toEqual(changed(profile()));
  await publication.replaceInvalid(
    { ...profile(), routes: [{ route: 'invalid', document: { root: { props: {} }, content: [] } }] },
    7,
  );
  expect(seen).toHaveLength(2);
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, reason: 'invalid' });
});

test('a pending request cannot be duplicated, and a malformed success cannot discard its intent', async () => {
  let complete!: (result: { ok: true; digest: string; head: number }) => void;
  let calls = 0;
  const publication = new CurationPublication({
    publish: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  const first = publication.start(profile(), 7);
  expect(await publication.retry()).toBeNull();
  expect(await publication.start(changed(profile()), 9)).toBeNull();
  expect(calls).toBe(1);
  complete({ ok: true, digest: profileDigest(profile()), head: 99 });
  expect(await first).toBeNull();
  expect(publication.getSnapshot().intent?.expectedHead).toBe(7);
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, outcome: 'unknown' });
});
