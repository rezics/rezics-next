import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import * as drafts from '../src/features/pages/curate-view-editor-state';
import { fromComposition, toComposition } from '../src/features/pages/editor-config';

const filter = { statement: { property: 'schema:genre', in: ['first', 'second'] } };
const title = { en: 'Books', ja: '本' };
const props = { id: 'list', title, types: ['schema:Book'], filter, sort: 'name', limit: 12 };
const document = { root: { props: {} }, content: [{ type: 'TypeList', props }] };
const profile: PresentationProfile = { format: PROFILE_FORMAT, generic: document, bases: [], types: [], routes: [] };

test.each([
  ['object key order', '{"statement":{"in":["first","second"],"property":"schema:genre"}}', 12, false],
  ['value edit', JSON.stringify(filter), 13, true],
  ['array order', '{"statement":{"property":"schema:genre","in":["second","first"]}}', 12, true],
  ['invalid JSON', '{', 12, true],
  ['canonicalization failure', JSON.stringify(filter), Infinity, true],
] as const)('%s survives confirmation and discard with meaningful dirty state', (_name, input, limit, dirty) => {
  const saved = { ok: true as const, reader: 'reader', profile, digest: profileDigest(profile), head: 7 };
  const draft = drafts.presentationDraft(saved);
  const data = fromComposition(document);
  data.content[0]!.props = { ...data.content[0]!.props, filter: input, limit, title: { ja: '本', en: 'Books' } };
  const changed = drafts.editView(draft, draft.selection, data);
  expect(drafts.hasDraftChanges(changed)).toBe(dirty);
  expect(drafts.draftPublicationProfile(draft, toComposition(data))).toEqual(dirty ? changed.profile : null);
  const confirmation = {
    intent: { reader: saved.reader, profile: structuredClone(profile), expectedHead: 7, key: 'key' },
    result: { ok: true as const, digest: saved.digest, head: 8 },
  };
  const confirmed = drafts.confirmPresentationDraft(changed, confirmation);
  expect(confirmed.profile).toBe(changed.profile);
  expect(confirmed.editors).toBe(changed.editors);
  expect(drafts.hasDraftChanges(confirmed)).toBe(dirty);
  expect(drafts.draftPublicationProfile(confirmed)).toEqual(dirty ? changed.profile : null);
  expect(drafts.hasDraftChanges(changed, confirmation.intent.profile)).toBe(dirty);
  expect(drafts.hasDraftChanges(drafts.discardPresentationDraft(confirmed))).toBe(false);
  if (input !== '{' && Number.isFinite(limit)) {
    confirmation.intent.profile = changed.profile;
    confirmation.result.digest = profileDigest(changed.profile);
    expect(drafts.hasDraftChanges(drafts.confirmPresentationDraft(changed, confirmation))).toBe(false);
  }
});
