import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import {
  confirmPresentationDraft,
  editView,
  hasDraftChanges,
  presentationDraft,
  reviewPresentationDraft,
  selectionKey,
} from '../src/features/pages/curate-view-editor-state';
import { viewOf } from '../src/features/pages/curate';
import { fromComposition } from '../src/features/pages/editor-config';
import { CurationPublication } from '../src/features/pages/curation-publish';

const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: { root: { props: {} }, content: [] },
      details: {
        root: { props: {} },
        content: [{ type: 'Heading', props: { id: 'details', level: 2, text: { en: 'Details', ja: '詳細' } } }],
      },
    },
  },
  bases: [],
  types: [],
  routes: [],
});
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const selection = { template: { scope: 'generic' as const, key: null }, view: 'details' as const };

function edit(draft: ReturnType<typeof presentationDraft>, text: string) {
  const data = fromComposition(viewOf(draft.profile, selection.template, selection.view)!);
  data.content[0]!.props.text = { en: text, ja: '詳細', fr: '' };
  return { ...editView(draft, selection, data), selection };
}

test('confirmation of the original publication preserves later per-view edits and their raw language fields', async () => {
  const initial = profile();
  let draft = presentationDraft({ ok: true, reader, profile: initial, head: 7, digest: profileDigest(initial) });
  draft = edit(draft, 'Original publication');
  let attempts = 0;
  const publication = new CurationPublication(reader, {
    publish: async (input) =>
      ++attempts === 1
        ? { ok: false, reason: 'unavailable', outcome: 'unknown' }
        : { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  await publication.start(draft.profile, draft.saved.head);
  const original = publication.getSnapshot().intent!;
  draft = edit(draft, 'Later unpublished edit');
  const raw = draft.editors[selectionKey(selection)];
  const confirmed = confirmPresentationDraft(draft, (await publication.retry())!);
  expect(confirmed.saved.profile).toEqual(original.profile);
  expect(confirmed.saved.head).toBe(8);
  expect(confirmed.profile).toBe(draft.profile);
  expect(confirmed.editors[selectionKey(selection)]).toBe(raw);
  expect(raw!.content[0]!.props.text).toEqual({ en: 'Later unpublished edit', ja: '詳細', fr: '' });
  expect(hasDraftChanges(confirmed)).toBe(true);

  const completed = await publication.start(confirmed.profile, confirmed.saved.head);
  expect(completed?.intent.expectedHead).toBe(8);
  expect(hasDraftChanges(confirmPresentationDraft(confirmed, completed!))).toBe(false);
});

test('reviewing a stale publication retains or explicitly discards every view against the actual active snapshot', async () => {
  const initial = profile();
  let draft = presentationDraft({ ok: true, reader, profile: initial, head: 7, digest: profileDigest(initial) });
  draft = edit(draft, 'Retained local draft');
  const activeProfile = profile();
  activeProfile.generic = { root: { props: {} }, content: [] };
  const active = { ok: true as const, reader, profile: activeProfile, digest: profileDigest(activeProfile), head: 9 };
  const publication = new CurationPublication(reader, {
    publish: async () => ({ ok: false, reason: 'stale' }),
    read: async () => active,
  });
  await publication.start(draft.profile, 7);
  const read = publication.getSnapshot().active!;
  const reviewed = publication.reconcile(draft.profile, 'keep')!;
  expect(reviewed.profile).toBe(draft.profile);
  const retained = reviewPresentationDraft(draft, read, 'keep');
  expect(retained.saved).toBe(active);
  expect(retained.editors).toBe(draft.editors);
  expect(retained.profile).toBe(draft.profile);
  expect(retained.selection).toEqual(selection);
  expect(hasDraftChanges(retained)).toBe(true);

  const discarded = reviewPresentationDraft(draft, read, 'discard');
  expect(discarded.saved).toBe(active);
  expect(discarded.profile).toBe(activeProfile);
  expect(discarded.editors).toEqual({});
  expect(discarded.selection).toEqual({ template: selection.template, view: 'overview' });
  expect(hasDraftChanges(discarded)).toBe(false);
});
