import { expect, test } from 'bun:test';
import { resolveAllData } from '@puckeditor/core';
import { PROFILE_FORMAT, platformRegistry, profileDigest } from '@rezics/composition';
import type { CompositionDocument, PresentationProfile } from '@rezics/composition';
import { editorConfig, fromComposition, toComposition } from '../src/features/pages/editor-config';
import { editView, hasDraftChanges, presentationDraft } from '../src/features/pages/curate-view-editor-state';

const config = editorConfig(platformRegistry, { locale: 'en' });
const document = (text: string | Record<string, string>): CompositionDocument => ({
  root: { props: {} },
  content: [
    {
      type: 'Columns',
      props: {
        id: 'columns',
        split: 'even',
        end: [],
        start: [{ type: 'LinkGrid', props: { id: 'links', links: [{ label: text, href: '/' }] } }],
      },
    },
  ],
});
const label = (data: ReturnType<typeof fromComposition>) =>
  (data.content[0]!.props.start as { props: { links: { label: unknown }[] } }[])[0]!.props.links[0]!;
const profile = (source: CompositionDocument): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { views: { overview: source } },
  bases: [],
  types: [],
  routes: [],
});

test('unchanged Puck values preserve localized representation, digest and the clean draft', async () => {
  for (const text of ['', 'Title', { en: 'Title', fr: '', it: 'Titolo', nl: '' }, { ja: '' }]) {
    const source = document(text);
    const saved = {
      ok: true as const,
      reader: 'editor',
      profile: profile(source),
      head: 1,
      digest: profileDigest(profile(source)),
    };
    const draft = presentationDraft(saved);
    const received = await resolveAllData(
      structuredClone(fromComposition(source)) as Parameters<typeof resolveAllData>[0],
      config,
    );
    const next = editView(draft, draft.selection, received);
    expect(toComposition(received)).toEqual(source);
    expect(profileDigest(next.profile)).toBe(saved.digest);
    expect(hasDraftChanges(next)).toBe(false);
  }
});

test('localized edits, translations and clears survive Puck resolution without losing other locales', async () => {
  for (const [text, edit, expected] of [
    ['', { en: 'Changed', fr: '' }, 'Changed'],
    ['Title', { en: '', fr: '' }, ''],
    ['Title', { en: 'Title', ja: '題' }, { en: 'Title', ja: '題' }],
    [
      { en: 'Title', fr: '', it: 'Titolo' },
      { en: '', fr: '', it: 'Titolo' },
      { en: '', fr: '', it: 'Titolo' },
    ],
    [{ en: 'Title', it: 'Titolo' }, { en: 'Changed' }, { en: 'Changed', it: 'Titolo' }],
  ] as const) {
    const data = structuredClone(fromComposition(document(text)));
    label(data).label = edit;
    const result = toComposition(await resolveAllData(data as Parameters<typeof resolveAllData>[0], config));
    expect(result).toEqual(document(expected));
  }
});
