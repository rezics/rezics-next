import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, resolveTemplate, type PresentationProfile } from '@rezics/composition';
import type { CurationRead } from '../src/features/pages/curate-actions';
import {
  confirmKeyedTemplateRemoval,
  keyedTemplateEntry,
  reviewKeyedTemplateRemoval,
  removeKeyedTemplate,
  type KeyedTemplate,
} from '../src/features/pages/curation-template-removal';
import {
  discardPresentationDraft,
  presentationDraft,
  selectTemplate,
  selectionKey,
} from '../src/features/pages/curate-view-editor-state';

const empty = { root: { props: {} }, content: [] };
const replaced = { root: { props: { appearance: { density: 'compact' as const } } }, content: [] };
const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { document: empty },
  bases: [{ base: 'schema:CreativeWork', document: empty }],
  types: [
    { type: 'schema:Book', document: empty },
    { type: 'schema:Movie', document: empty },
  ],
  routes: [{ route: '/help', document: empty }],
});
const saved = (value = profile()): Extract<CurationRead, { ok: true }> => ({
  ok: true,
  reader: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  profile: value,
  head: 7,
  digest: profileDigest(value),
});
const typeTemplate = { scope: 'type', key: 'schema:Book' } as const;
const live = (current = true) => ({ isCurrent: () => current });

test('removing one keyed template changes only the draft entry and falls back to the existing base', () => {
  const snapshot = saved();
  const template = typeTemplate;
  const draft = removeKeyedTemplate(selectTemplate(presentationDraft(snapshot), template), template);
  expect(draft.profile.types).toEqual([snapshot.profile.types[1]]);
  expect(draft.profile.generic).toBe(snapshot.profile.generic);
  expect(draft.profile.bases).toBe(snapshot.profile.bases);
  expect(draft.profile.routes).toBe(snapshot.profile.routes);
  expect(draft.selection.template).toEqual({ scope: 'generic', key: null });
  expect(discardPresentationDraft(draft).profile).toBe(snapshot.profile);
  expect(resolveTemplate(draft.profile, { type: 'schema:Book', bases: ['schema:CreativeWork'] })).toMatchObject({
    scope: 'base',
    key: 'schema:CreativeWork',
    document: snapshot.profile.bases[0]!.document,
  });
});

test('A refreshed keyed template cannot be removed using confirmation of its superseded definition', () => {
  const original = profile();
  const draft = selectTemplate(presentationDraft(saved(original)), typeTemplate);
  const lifetime = live();
  const intention = reviewKeyedTemplateRemoval(draft, typeTemplate, lifetime)!;
  expect(intention).toBeTruthy();
  const cancelled = draft;
  expect(cancelled.profile).toBe(original);

  const refreshed: PresentationProfile = {
    ...original,
    types: [{ type: 'schema:Book', document: replaced }, original.types[1]!],
  };
  const replacedDraft = presentationDraft(saved(refreshed));
  expect(confirmKeyedTemplateRemoval(replacedDraft, intention).profile).toBe(replacedDraft.profile);
  expect(confirmKeyedTemplateRemoval(replacedDraft, intention).profile.types).toEqual(refreshed.types);

  const gone = presentationDraft(saved({ ...original, types: [original.types[1]!] }));
  expect(confirmKeyedTemplateRemoval(gone, intention)).toBe(gone);

  const equivalent = presentationDraft(
    saved({
      ...original,
      types: original.types.map((entry) => ({ ...entry })),
      bases: original.bases.map((entry) => ({ ...entry })),
      routes: original.routes.map((entry) => ({ ...entry })),
    }),
  );
  expect(confirmKeyedTemplateRemoval(equivalent, intention).profile.types).toEqual([original.types[1]]);

  const sibling = presentationDraft(saved({ ...original, routes: [...original.routes, { route: '/other', document: empty }] }));
  expect(confirmKeyedTemplateRemoval(sibling, intention).profile.types.map((entry) => entry.type)).toEqual(['schema:Movie']);
  expect(confirmKeyedTemplateRemoval(sibling, intention).profile.routes).toEqual([
    ...original.routes,
    { route: '/other', document: empty },
  ]);

  expect(confirmKeyedTemplateRemoval(draft, intention).profile.types).toEqual([original.types[1]]);

  lifetime.isCurrent = () => false;
  expect(confirmKeyedTemplateRemoval(draft, intention)).toBe(draft);
  expect(reviewKeyedTemplateRemoval(draft, typeTemplate, live(false))).toBeNull();

  const editors = { [selectionKey({ template: typeTemplate, view: 'overview' })]: { root: { props: {} }, content: [] } };
  const withEditors = { ...draft, editors };
  const editedIntention = reviewKeyedTemplateRemoval(withEditors, typeTemplate, live())!;
  expect(confirmKeyedTemplateRemoval(draft, editedIntention)).toBe(draft);
  expect(confirmKeyedTemplateRemoval({ ...equivalent, editors: { ...editors } }, editedIntention).profile.types).toEqual([
    original.types[1],
  ]);

  const scopes: KeyedTemplate[] = [
    { scope: 'base', key: 'schema:CreativeWork' },
    typeTemplate,
    { scope: 'route', key: '/help' },
  ];
  expect(
    scopes.map((template) => {
      const entry = keyedTemplateEntry(original, template);
      return entry && ('base' in entry ? entry.base : 'type' in entry ? entry.type : entry.route);
    }),
  ).toEqual(['schema:CreativeWork', 'schema:Book', '/help']);
  expect(scopes.map((template) => keyedTemplateEntry({ ...original, bases: [], types: [], routes: [] }, template))).toEqual(
    [undefined, undefined, undefined],
  );
});
