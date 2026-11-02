import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { PresentationViewEditor } from '../src/features/pages/curate-view-editor';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

test('companion editing follows the explicit editor locale alongside its template and view controls', () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const profile: PresentationProfile = {
      format: PROFILE_FORMAT,
      generic: { root: { props: {} }, content: [] },
      bases: [],
      types: [],
      routes: [],
    };
    const html = renderToStaticMarkup(
      createElement(PresentationViewEditor, {
        initial: { ok: true, reader: 'curator', profile, digest: profileDigest(profile), head: 7 },
        locale: 'ja',
        transport: {
          read: async () => ({ ok: false, reason: 'unavailable' }),
          publish: async () => ({ ok: false, reason: 'unavailable' }),
        },
      }),
    );
    for (const message of [
      m.curation_template,
      m.curation_companion_views,
      m.curation_companion_view,
      m.curation_companion_source,
      m.curation_companion_source_choose,
      m.curation_companion_source_empty,
      m.curation_companion_source_overview,
      m.curation_companion_add,
    ]) {
      expect(html).toContain(message({}, { locale: 'ja' }));
      expect(html).not.toContain(message({}, { locale: 'en' }));
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
