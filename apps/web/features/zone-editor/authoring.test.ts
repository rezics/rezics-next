import { fromPlainText } from '@rezics/document';
import { expect, test } from 'bun:test';
import type { WriteRound } from '../api/command.ts';
import { commitCommand, type WriteResult } from './api.ts';
import {
  authoringModel, blankDocument, canPublish, draftChoice, draftWire, isDirty, publicationChoice, publicationWire, reduceEditor,
  type EditorState,
} from './model.ts';

const zoneId = '00000000-0000-4000-8000-000000000201';
const zoneIri = `https://rezics.com/id/${zoneId}`;
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000202';
const navigation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000203';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000204';
const variantId = 'urn:rezics:variant:00000000-0000-4000-8000-000000000205';
const revision = '00000000-0000-4000-8000-000000000206';
const epoch = '00000000-0000-4000-8000-000000000207';
const digest = 'ab'.repeat(32);
const head = '00000000-0000-4000-8000-000000000208';
const readingDirection = 'ltr' as const;

const zone = { revision: navigation, ownerRevision: zoneHead };

function showcase(document: unknown, revisionId: string | null) {
  return {
    revision: zoneHead, name: 'Harbor notes', language: 'en', direction: readingDirection,
    draft: {
      variantId, revisionId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: readingDirection,
      document, byteDigest: revisionId ? digest : null, editable: true,
      sourcePosition: { owner: 'content', dataEpoch: epoch, sequence: '4' },
    },
    publishedPage: null,
  };
}

function state(): EditorState {
  const model = authoringModel(showcase(fromPlainText('Morning edition', 'blocks'), revision), zone, zoneId, 'Harbor');
  if (!model) throw new Error('fixture');
  return model.state;
}

const round = (key = 'command-key', superseded = false): WriteRound => ({
  seq: 1, key, superseded: () => superseded, confirm() {}, afterConfirmed: false,
});

test('a stale save keeps the author’s text and the head they wrote against', () => {
  const start = state();
  const edited = reduceEditor(start, { type: 'edit', value: 'A note from this tab' });
  const stale = reduceEditor(edited, { type: 'stale', currentHead: head });
  expect(stale.value).toBe('A note from this tab');
  expect(stale.expectedHead).toBe(revision);
  expect(stale.notice).toEqual({ kind: 'stale', currentHead: head });
  const retargeted = reduceEditor(stale, { type: 'retarget', currentHead: head });
  expect(retargeted.value).toBe(stale.value);
  expect(retargeted.expectedHead).toBe(head);
  expect(retargeted.basis).toEqual(start.basis);
});

test('loading the saved page replaces the text only then', () => {
  const start = reduceEditor(state(), { type: 'edit', value: 'Kept until load' });
  const savedPage = blankDocument();
  const loaded = reduceEditor(start, {
    type: 'loaded', value: savedPage, expectedHead: head, basis: null, variantId, language: start.language,
    direction: start.direction, zoneHead, publishedRevisionId: null,
  });
  expect(loaded.value).toBe(savedPage);
  expect(loaded.value).not.toBe('Kept until load');
  expect(loaded.savedValue).toBeNull();
  expect(loaded.notice.kind).toBe('loaded');
});

test('publishing records the saved revision and the new zone head without changing the text', () => {
  const start = state();
  expect(canPublish(start)).toBe(true);
  const published = reduceEditor(start, { type: 'published', zoneHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000209', replayed: false });
  expect(published.value).toBe(start.value);
  expect(published.publishedRevisionId).toBe(revision);
  expect(published.zoneHead).toBe('https://rezics.com/id/00000000-0000-4000-8000-000000000209');
  expect(canPublish(published)).toBe(true);
  const edited = reduceEditor(published, { type: 'edit', value: 'Evening edition' });
  expect(isDirty(edited)).toBe(true);
  expect(canPublish(edited)).toBe(false);
  expect(edited.publishedRevisionId).toBe(revision);
});

test('a first empty page can be saved and cannot be published', () => {
  const model = authoringModel(showcase(null, null), zone, zoneId, 'Harbor');
  if (!model) throw new Error('fixture');
  expect(model.state.savedValue).toBeNull();
  expect(model.state.expectedHead).toBeNull();
  expect(isDirty(model.state)).toBe(false);
  expect(canPublish(model.state)).toBe(false);
  const typed = reduceEditor(model.state, { type: 'edit', value: 'Harbor morning' });
  expect(isDirty(typed)).toBe(true);
  expect(canPublish(typed)).toBe(false);
});

test('a save that lands keeps a keystroke made while it was in flight', () => {
  const start = state();
  const choice = draftChoice(start, zoneIri, actor);
  const typed = reduceEditor(start, { type: 'edit', value: 'Still in the field' });
  const saved = reduceEditor(typed, {
    type: 'saved', captured: choice.captured, savedValue: choice.savedValue,
    basis: { revisionId: head, byteDigest: digest, contentEpoch: epoch }, replayed: false,
  });
  expect(saved.value).toBe('Still in the field');
  expect(saved.savedValue).toBe(choice.savedValue);
  expect(saved.expectedHead).toBe(head);
  expect(isDirty(saved)).toBe(true);
});

test('the publication names one structure revision for routes and navigation, and the saved basis', () => {
  const start = state();
  const choice = publicationChoice(start, zoneIri);
  if (!choice) throw new Error('publishable');
  const body = publicationWire(choice, actor);
  expect(body.routesRevision).toBe(navigation);
  expect(body.navigationRevision).toBe(navigation);
  expect(body.expectedHead).toBe(zoneHead);
  expect(body.pages).toEqual([{ page: zoneIri, variantId, revisionId: revision, byteDigest: digest, contentEpoch: epoch }]);
  const wire = draftWire(draftChoice(start, zoneIri, actor));
  expect(wire.profile).toBe('content-text-v1');
  expect(wire.expectedHead).toBe(revision);
  expect(wire).not.toHaveProperty('captured');
  expect(wire.document.profile).toBe('blocks');
});

test('a lost response is retried once with the same key, and a stale head is not', async () => {
  const keys: string[] = [];
  const lost = await commitCommand(round(), async key => {
    keys.push(key);
    if (keys.length === 1) return { ok: false, failure: 'unavailable' };
    return { ok: true, data: 'published' };
  });
  expect(lost).toEqual({ ok: true, data: 'published' });
  expect(keys).toEqual(['command-key', 'command-key']);

  let staleCalls = 0;
  const stale: WriteResult<string> = { ok: false, failure: 'stale', currentHead: head };
  const refused = await commitCommand(round('other-key'), async () => {
    staleCalls += 1;
    return stale;
  });
  expect(refused).toBe(stale);
  expect(staleCalls).toBe(1);

  let thrown = 0;
  const recovered = await commitCommand(round('thrown'), async () => {
    thrown += 1;
    if (thrown === 1) throw new Error('response lost');
    return { ok: true, data: 'once' };
  });
  expect(recovered).toEqual({ ok: true, data: 'once' });
  expect(thrown).toBe(2);
});

test('notes and a document this editor cannot read are not offered for saving', () => {
  const noted = authoringModel({ ...showcase(fromPlainText('Kept', 'blocks'), revision), draft: { ...showcase(null, revision).draft, notes: { before: { body: 'aside' } }, document: fromPlainText('Kept', 'blocks') } }, zone, zoneId, 'Harbor');
  expect(noted?.editable).toBe(false);
  const broken = authoringModel(showcase({ not: 'a document' }, revision), zone, zoneId, 'Harbor');
  expect(broken?.editable).toBe(false);
  expect(broken?.document).toBeNull();
});
