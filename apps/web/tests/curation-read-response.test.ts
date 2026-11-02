import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { admitCurationReads } from '../src/features/pages/curation-read-response';

const empty = { root: { props: {} }, content: [] };
const shorthand: PresentationProfile = { format: PROFILE_FORMAT, generic: empty, bases: [], types: [], routes: [] };
const multiView: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: empty, details: empty } },
  bases: [],
  types: [],
  routes: [],
};
const digest = profileDigest(shorthand);
const other = profileDigest(multiView);
const reader = '0192f3a0-6c1e-7b2a-9d4e-00000000000a';
const unused = async (): Promise<never> => {
  throw new Error('profile requested');
};

test.each([
  ['digest', { digest: `sha256:${'A'.repeat(64)}`, head: 1 }],
  ['head', { digest, head: -1 }],
  ['unsafe head', { digest, head: Number.MAX_SAFE_INTEGER + 1 }],
] as const)('malformed active %s is unavailable without a profile request', async (_name, data) => {
  await expect(admitCurationReads(reader, { status: 200, data }, unused)).resolves.toEqual({
    ok: false,
    reason: 'unavailable',
  });
});

test('wrong returned digest is unavailable', async () => {
  await expect(
    admitCurationReads(reader, { status: 200, data: { digest, head: 0 } }, async () => ({
      status: 200,
      data: { digest: other, profile: shorthand },
    })),
  ).resolves.toEqual({ ok: false, reason: 'unavailable' });
});

test('valid-shaped profile with a different digest is unavailable', async () => {
  await expect(
    admitCurationReads(reader, { status: 200, data: { digest, head: 2 } }, async () => ({
      status: 200,
      data: { digest, profile: multiView },
    })),
  ).resolves.toEqual({ ok: false, reason: 'unavailable' });
});

test('native extras cannot impersonate the session reader or success flag', async () => {
  await expect(
    admitCurationReads(
      reader,
      { status: 200, data: { digest, head: 4, ok: false, reader: 'impersonator' } },
      async () => ({ status: 200, data: { digest, profile: shorthand, ok: false, reader: 'other' } }),
    ),
  ).resolves.toEqual({ ok: true, reader, digest, head: 4, profile: shorthand });
});

test('coherent shorthand and multi-view profiles are admitted', async () => {
  await expect(
    admitCurationReads(reader, { status: 200, data: { digest: other, head: 5 } }, async () => ({
      status: 200,
      data: { digest: other, profile: multiView },
    })),
  ).resolves.toEqual({ ok: true, reader, digest: other, head: 5, profile: multiView });
});

test('native refusals keep their mapped failure and skip a later profile read', async () => {
  await expect(admitCurationReads(reader, { status: 403, error: { value: { code: 'forbidden' } } }, unused)).resolves.toEqual({
    ok: false,
    reason: 'forbidden',
  });
  await expect(
    admitCurationReads(reader, { status: 200, data: { digest, head: 1 } }, async () => ({
      status: 429,
      error: { value: { code: 'overloaded' } },
      headers: { 'retry-after': '8' },
    })),
  ).resolves.toEqual({ ok: false, reason: 'rate-limited', retryAfter: 8 });
});
