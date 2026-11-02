import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, resolveTemplate, type PresentationProfile } from '@rezics/composition';
import type { CurationRead } from '../src/features/pages/curate-actions';
import { removeKeyedTemplate } from '../src/features/pages/curation-template-removal';
import { discardPresentationDraft, presentationDraft, selectTemplate } from '../src/features/pages/curate-view-editor-state';

test('removing one keyed template changes only the draft entry and falls back to the existing base', () => {
  const empty = { root: { props: {} }, content: [] };
  const profile: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: { document: empty },
    bases: [{ base: 'schema:CreativeWork', document: empty }],
    types: [{ type: 'schema:Book', document: empty }, { type: 'schema:Movie', document: empty }],
    routes: [{ route: '/help', document: empty }],
  };
  const saved: Extract<CurationRead, { ok: true }> = {
    ok: true,
    reader: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    profile,
    head: 7,
    digest: profileDigest(profile),
  };
  const template = { scope: 'type', key: 'schema:Book' } as const;
  const draft = removeKeyedTemplate(selectTemplate(presentationDraft(saved), template), template);
  expect(draft.profile.types).toEqual([profile.types[1]]);
  expect(draft.profile.generic).toBe(profile.generic);
  expect(draft.profile.bases).toBe(profile.bases);
  expect(draft.profile.routes).toBe(profile.routes);
  expect(draft.selection.template).toEqual({ scope: 'generic', key: null });
  expect(discardPresentationDraft(draft).profile).toBe(profile);
  expect(resolveTemplate(draft.profile, { type: 'schema:Book', bases: ['schema:CreativeWork'] })).toMatchObject({
    scope: 'base',
    key: 'schema:CreativeWork',
    document: profile.bases[0]!.document,
  });
});
