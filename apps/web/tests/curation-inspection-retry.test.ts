import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import type { PublishInput, PublishResult } from '../src/features/pages/curate';
import {
  CurationPublication,
  type ActiveCuration,
  type PublicationRead,
  type PublicationTransport,
} from '../src/features/pages/curation-publish';
import { CurationPublicationRecovery } from '../src/features/pages/curation-publish-view';
import { m } from '../src/paraglide/messages.js';

const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
});

function buttonDisabled(html: string, label: string) {
  const at = html.indexOf(label);
  return at !== -1 && /\sdisabled(?:\s|=|>|$)/.test(html.slice(html.lastIndexOf('<button', at), at));
}

test('retained publication inspection honors its own native deadline across visits and stale command reads', async () => {
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const draft = profile();
  const active: ActiveCuration = { ok: true, reader, profile: draft, digest: profileDigest(draft), head: 9 };
  const publications: PublishResult[] = [
    { ok: false, reason: 'rate-limited', retryAfter: 2 },
    { ok: false, reason: 'stale', phase: 'activate' },
  ];
  const readReplies: PublicationRead[] = [
    { ok: false, reason: 'rate-limited', retryAfter: 10 },
    { ok: false, reason: 'rate-limited', retryAfter: 5 },
    active,
  ];
  const published: PublishInput[] = [];
  const readCalls: number[] = [];
  const transport: PublicationTransport = {
    publish: async (input) => {
      published.push(structuredClone(input));
      return publications.shift()!;
    },
    read: async () => {
      readCalls.push(now);
      return readReplies.shift()!;
    },
  };
  const publication = new CurationPublication(reader, transport);
  const visit = publication.activate(transport);
  const html = () =>
    renderToStaticMarkup(
      createElement(CurationPublicationRecovery, {
        publication,
        profile: draft,
        head: 7,
        onPublished: () => {},
        onReviewed: () => {},
      }),
    );

  try {
    await visit.start(draft, 7);
    const intent = publication.getSnapshot().intent!;
    expect(publication.getSnapshot().retryAt).toBe(3_000);
    now = 2_000;
    await visit.inspect();
    expect(readCalls).toEqual([2_000]);
    expect(publication.getSnapshot().readRetryAt).toBe(12_000);
    expect(html()).toContain(m.curation_retry_after({ seconds: 10 }));
    expect(buttonDisabled(html(), m.curation_reload_head())).toBe(true);

    now = 3_000;
    await visit.retry();
    expect(published).toEqual([
      { profile: intent.profile, expectedHead: 7, keys: intent.keys },
      { profile: intent.profile, expectedHead: 7, keys: intent.keys },
    ]);
    expect(readCalls).toEqual([2_000]);
    publication.retire(visit);
    const resumed = publication.activate(transport);
    await visit.inspect();
    await resumed.inspect();
    now = 12_000;
    expect(readCalls).toEqual([2_000]);
    await visit.inspect();
    await resumed.inspect();
    expect(readCalls).toEqual([2_000, 12_000]);
    expect(publication.getSnapshot().readRetryAt).toBe(17_000);

    now = 16_999;
    await resumed.inspect();
    expect(readCalls).toEqual([2_000, 12_000]);
    expect(html()).toContain(m.curation_retry_after({ seconds: 5 }));
    expect(buttonDisabled(html(), m.curation_reload_head())).toBe(true);
    now = 17_000;
    expect(readCalls).toEqual([2_000, 12_000]);
    expect(buttonDisabled(html(), m.curation_reload_head())).toBe(false);
    await resumed.inspect();
    expect(readCalls).toEqual([2_000, 12_000, 17_000]);
    expect(publication.getSnapshot().active).toEqual(active);
    expect(publication.getSnapshot().intent).toBe(intent);
    expect(publication.getSnapshot().result).toMatchObject({ ok: false, reason: 'stale' });
  } finally {
    clock.mockRestore();
  }
});
