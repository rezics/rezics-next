import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { withTemplate, type PublishInput, type PublishResult } from '../src/features/pages/curate';
import { CurationPublication } from '../src/features/pages/curation-publish';
import { admitPublicationRetry, publicationRetryAt } from '../src/features/pages/curation-retry-admission';

const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
});

function buttonMarkup(html: string, label: string) {
  const at = html.indexOf(label);
  return at === -1 ? '' : html.slice(html.lastIndexOf('<button', at), at);
}

test('a native Retry-After seconds hint becomes one absolute deadline that re-reads cannot shorten', () => {
  expect(publicationRetryAt(30, 1_000)).toBe(31_000);
  expect(publicationRetryAt(0, 1_000)).toBe(1_000);
  expect(publicationRetryAt(undefined, 1_000)).toBeUndefined();
  expect(admitPublicationRetry(31_000, 30_999)).toBe(false);
  expect(admitPublicationRetry(31_000, 31_000)).toBe(true);
  expect(admitPublicationRetry(undefined, 1_000)).toBe(true);
});

test('a rate-limited retained publication cannot be resent before its native deadline, and later manual retry preserves the original profile and idempotency keys', async () => {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const seen: PublishInput[] = [];
  const reads: number[] = [];
  const replies: PublishResult[] = [
    { ok: false, reason: 'rate-limited', retryAfter: 30, phase: 'activate' },
    { ok: false, reason: 'rate-limited', retryAfter: 60 },
    { ok: true, digest: profileDigest(profile()), head: 8 },
  ];
  const transport = {
    publish: async (input: PublishInput) => {
      seen.push(input);
      return structuredClone(replies[seen.length - 1]!);
    },
    read: async () => {
      reads.push(now);
      return { ok: false as const, reason: 'unavailable' as const };
    },
  };
  const publication = new CurationPublication(reader, transport);
  const later = withTemplate(
    profile(),
    { scope: 'route', key: '/books' },
    { root: { props: {} }, content: [{ type: 'Text', props: { id: 'books', text: { en: 'Later' } } }] },
  );
  try {
    await publication.start(profile(), 7);
    const original = publication.getSnapshot().intent!;
    const deadline = publication.getSnapshot().retryAt;
    expect(deadline).toBe(31_000);
    expect(seen).toHaveLength(1);
    expect(publication.getSnapshot().result).toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfter: 30,
      phase: 'activate',
    });

    now = 5_000;
    expect(publication.getSnapshot().retryAt).toBe(deadline);
    expect(await publication.retry()).toBeNull();
    expect(seen).toHaveLength(1);
    expect(await publication.start(later, 9)).toBeNull();
    await publication.inspect();
    expect(reads).toEqual([5_000]);
    expect(publication.getSnapshot().readFailure).toEqual({ ok: false, reason: 'unavailable' });

    now = 31_000;
    expect(seen).toHaveLength(1);
    publication.retire();
    const resumed = publication.activate(transport);
    expect(publication.getSnapshot().intent).toBe(original);
    expect(publication.getSnapshot().retryAt).toBe(deadline);
    expect(await resumed.retry()).toBeNull();
    expect(seen).toEqual([
      { profile: original.profile, expectedHead: 7, keys: original.keys },
      { profile: original.profile, expectedHead: 7, keys: original.keys },
    ]);
    expect(publication.getSnapshot().intent).toBe(original);
    expect(publication.getSnapshot().retryAt).toBe(91_000);

    now = 91_000;
    const confirmed = await resumed.retry();
    expect(confirmed).toEqual({
      intent: original,
      result: { ok: true, digest: profileDigest(profile()), head: 8 },
    });
    expect(confirmed?.intent.keys).toEqual(original.keys);
    expect(seen[2]).toEqual({ profile: original.profile, expectedHead: 7, keys: original.keys });
  } finally {
    clock.mockRestore();
  }

  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CurationPublicationRecovery } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const waiting = new CurationPublication(reader, {
    publish: async () => ({ ok: false, reason: 'rate-limited', retryAfter: 30 }),
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  await waiting.start(profile(), 7);
  const html = renderToStaticMarkup(
    createElement(CurationPublicationRecovery, {
      publication: waiting,
      profile: profile(),
      head: 7,
      onPublished: () => {},
      onReviewed: () => {},
    }),
  );
  expect(html).toContain(m.curation_retry_after({ seconds: 30 }));
  expect(buttonMarkup(html, m.curation_retry_original())).toContain('disabled');
  expect(buttonMarkup(html, m.curation_reload_head())).not.toContain('disabled');
});
