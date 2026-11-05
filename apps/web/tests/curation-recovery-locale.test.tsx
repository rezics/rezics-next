import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { PresentationViewEditor } from '../src/features/pages/curate-view-editor';
import { CurationPublication } from '../src/features/pages/curation-publish';
import {
  CurationFailureNotice,
  CurationProfileComparison,
  CurationPublicationRecovery,
} from '../src/features/pages/curation-publish-view';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { languageName } from '../src/subject/language';

const ja = { locale: 'ja' as const };
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const pointer = '/generic/views/overview/content/0/props/text';
const page = (text: Record<string, string>) => ({
  root: {
    props: {
      appearance: { density: 'comfortable', radius: 'md', surface: 'flat', cover: 'portrait', headingScale: 'lg' },
    },
  },
  content: [{ type: 'Heading', props: { id: 'notes', text, level: 2 } }],
});
const profile = (text: Record<string, string>): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { views: { overview: page(text), details: { root: { props: {} }, content: [] } } },
  bases: [],
  types: [],
  routes: [],
});

test('an explicit Japanese editor locale overrides ambient English in recovery while keeping authored values', async () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const notice = (failure: Parameters<typeof CurationFailureNotice>[0]['failure'], locale?: string) =>
      renderToStaticMarkup(createElement(CurationFailureNotice, { failure, locale }));
    const ordinary = notice({ ok: false, reason: 'unavailable' }, 'ja');
    expect(ordinary).toContain(m.curation_unavailable({}, ja));
    expect(ordinary).not.toContain(m.curation_unavailable());
    const partial = notice({ ok: false, reason: 'unavailable', outcome: 'unknown', phase: 'activate' }, 'ja');
    expect(partial).toContain(m.curation_unknown({}, ja));
    expect(partial).toContain(m.curation_partial({}, ja));
    expect(partial).not.toContain(m.curation_unknown());
    expect(partial).not.toContain(m.curation_partial());
    const limited = notice({ ok: false, reason: 'rate-limited', retryAfter: 45 }, 'ja');
    expect(limited).toContain(m.curation_limited({}, ja));
    expect(limited).toContain(m.curation_retry_after({ seconds: 45 }, ja));
    expect(limited).toContain('45');
    expect(limited).not.toContain(m.curation_limited());
    const invalid = notice({ ok: false, reason: 'invalid', errors: [{ pointer, code: 'invalid_format' }] }, 'ja');
    expect(invalid).toContain(m.curation_invalid({}, ja));
    expect(invalid).toContain(pointer);
    expect(invalid).toContain('invalid_format');
    expect(notice({ ok: false, reason: 'unavailable' }, 'not-a-locale')).toContain(m.curation_unavailable());
    expect(notice({ ok: false, reason: 'unavailable' })).toContain(m.curation_unavailable());

    const authored = { en: 'New heading', ja: '新しい読書ノート', qaa: 'qaa-authored-label' };
    const active = profile({ en: 'Saved heading', ja: '読書ノート', qaa: 'qaa-authored-label' });
    const draft = structuredClone(active);
    if (!('views' in draft.generic)) throw new Error('Expected a multi-view draft');
    draft.generic.views.overview.root.props.appearance = {
      density: 'compact',
      radius: 'md',
      surface: 'flat',
      cover: 'portrait',
      headingScale: 'lg',
    };
    draft.generic.views.overview.content[0]!.props.text = authored;
    const compared = renderToStaticMarkup(createElement(CurationProfileComparison, { draft, active, locale: 'ja' }));
    expect(compared).toContain(m.curation_review_density({}, ja));
    expect(compared).toContain(m.curation_review_compact({}, ja));
    expect(compared).toContain(m.curation_draft({}, ja));
    expect(compared).toContain(`${languageName('en', 'ja')} (en)`);
    expect(compared).toContain(m.curation_review_unknown_field({ field: 'qaa' }, ja));
    expect(compared).toContain('New heading');
    expect(compared).toContain('新しい読書ノート');
    expect(compared).toContain('qaa-authored-label');
    expect(compared).not.toContain(m.curation_review_density());
    expect(compared).not.toContain(`${languageName('en', 'en')} (en)`);

    const transport = {
      publish: async () => ({ ok: false as const, reason: 'stale' as const }),
      read: async () => ({ ok: true as const, reader, head: 9, digest: profileDigest(active), profile: active }),
    };
    const stale = new CurationPublication(reader, transport);
    await stale.start(active, 7);
    const recovery = renderToStaticMarkup(
      createElement(CurationPublicationRecovery, {
        publication: stale,
        profile: draft,
        head: 7,
        locale: 'ja',
        onPublished: () => {},
        onReviewed: () => {},
      }),
    );
    expect(recovery).toContain(m.curation_stale({}, ja));
    expect(recovery).toContain(m.curation_reconcile({}, ja));
    expect(recovery).toContain(m.curation_retry_original({}, ja));
    expect(recovery).toContain(m.curation_review_density({}, ja));
    expect(recovery).toContain(profileDigest(active));
    expect(recovery).toContain('New heading');
    expect(recovery).not.toContain(m.curation_stale());
    expect(recovery).not.toContain(m.curation_reconcile());

    const waiting = new CurationPublication(reader, {
      publish: async () => ({ ok: false, reason: 'rate-limited', retryAfter: 45 }),
      read: async () => ({ ok: false, reason: 'unavailable' }),
    });
    await waiting.start(active, 7);
    const rateLimited = renderToStaticMarkup(
      createElement(CurationPublicationRecovery, {
        publication: waiting,
        profile: draft,
        head: 7,
        locale: 'ja',
        onPublished: () => {},
        onReviewed: () => {},
      }),
    );
    expect(rateLimited).toContain(m.curation_retry_after({ seconds: 45 }, ja));
    expect(rateLimited).toContain('45');
    expect(rateLimited).not.toContain(m.curation_retry_after({ seconds: 45 }));

    const editor = renderToStaticMarkup(
      createElement(PresentationViewEditor, {
        initial: { ok: false, reason: 'signed-out' },
        locale: 'ja',
        transport: {
          read: async () => ({ ok: false, reason: 'unavailable' }),
          publish: async () => ({ ok: false, reason: 'unavailable' }),
        },
      }),
    );
    expect(editor).toContain(m.curation_signed_out({}, ja));
    expect(editor).not.toContain(m.curation_signed_out());
  } finally {
    setLocale(previous, { reload: false });
  }
});
