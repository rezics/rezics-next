import { expect, test } from 'vitest';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import navigationAndTheme from '../../../../tests/qa/fixtures/outcomes/zone/navigation-and-theme.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, browserZoneNavigation, browserZoneTheme } from './api.ts';
import { authoringModel, canPublish, draftChoice, draftWire, publicationChoice, publicationWire, reduceEditor } from './model.ts';
import { confirmPublicationReview, readSavedPublicationSelection, reviewedPublicationChoice, stagePublicationReview } from './publication-review.ts';
import { recordedActingSubject, zoneIdFromRecordedPath } from './zone-navigation-theme-recorded-page.ts';

const record = navigationAndTheme as AnswerRecord;
const sample = (label: string) => {
  const found = record.personas.owner.find(item => item.label === label);
  if (!found) throw new Error(`Missing owner record: ${label}`);
  return found;
};
const editor = sample('showcase-editor');
const zoneId = zoneIdFromRecordedPath(editor.path);
const actor = recordedActingSubject(editor.path);
const zoneIri = `https://rezics.com/id/${zoneId}`;

function opening(showcase: unknown = editor.answer) {
  const model = authoringModel(showcase, sample('draft-navigation').answer, zoneId, 'Recorded site');
  if (!model) throw new Error('Authorized recorded editor must load');
  return model;
}

function session() {
  const replay = recordedFetch(record, 'owner', [{ label: 'mount-target-work', state: 'error' }, ...[
    'showcase-editor', 'draft-navigation', 'draft-navigation-editor', 'draft-configuration',
    'mount-target-collection-name', 'publish-site-bundle',
  ].map(label => ({ label, state: 'populated' as const }))], { pathPrefix: BFF_PREFIX });
  const statuses: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const answer = await replay.fetcher(input, init);
    statuses.push(answer.status);
    return answer;
  };
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  return { replay, main, statuses, authoring: browserZoneAuthoring(main) };
}

test('prepared home identity is distinct from the Zone and captured with the exact saved Content basis', () => {
  const { state } = opening();
  const body = sample('publish-site-bundle').body as { pages: unknown[] };
  expect(state.homeDocument).not.toBe(zoneIri);
  const draft = draftChoice(state, actor);
  expect(draftWire(draft)).toMatchObject({ resourceId: state.homeDocument, actingSubject: actor,
    expectedHead: state.expectedHead, variantId: state.variantId, language: state.language, direction: state.direction });
  const choice = publicationChoice(state);
  if (!choice) throw new Error('Saved recorded home is publishable');
  expect(publicationWire(choice, actor).pages).toEqual(body.pages);
  const changed = reduceEditor(state, { type: 'loaded', ...state,
    homeDocument: 'https://rezics.com/id/00000000-0000-4000-8000-000000000999' });
  expect(draft.resourceId).toBe(state.homeDocument);
  expect(choice.page).toBe(state.homeDocument);
  expect(draftChoice(changed, actor).resourceId).toBe(changed.homeDocument);
});

test.each([undefined, null, zoneId, 'https://rezics.com/id/------------------------------------'])
('missing or malformed prepared home identity is never replaced by the Zone (%j)', homeDocument => {
  const saved = editor.answer as { configuration: object };
  expect(authoringModel({ ...saved, configuration: { ...saved.configuration, homeDocument } },
    sample('draft-navigation').answer, zoneId, 'Recorded site')).toBeNull();
  const invalid = { ...opening().state, homeDocument: homeDocument as string };
  expect(canPublish(invalid)).toBe(false);
  expect(publicationChoice(invalid)).toBeNull();
  expect(() => draftChoice(invalid, actor)).toThrow('Prepared home document is unavailable');
});

test('production draft reload retains the prepared identity and accepts both unchanged authorized reads', async () => {
  const s = session();
  try {
    const read = await s.authoring.readDraft(zoneId, actor);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Recorded reload refused');
    expect(s.statuses).toEqual([200, 200]);
    const reloaded = reduceEditor(opening().state, { type: 'loaded', ...read.data });
    expect(reloaded.homeDocument).toBe(opening().state.homeDocument);
    expect(draftChoice(reloaded, actor).resourceId).toBe(reloaded.homeDocument);
    expect(publicationChoice(reloaded)?.page).toBe(reloaded.homeDocument);
  } finally { s.replay.dispose(); }
});

test('production publication accepts the unchanged owner 201 at the Zone endpoint', async () => {
  const s = session();
  try {
    const state = opening().state;
    const choice = publicationChoice(state);
    if (!choice) throw new Error('Saved recorded home is publishable');
    const result = await s.authoring.publish(choice, actor, crypto.randomUUID(), zoneId);
    const answer = sample('publish-site-bundle').answer as { revision: string };
    expect(result).toEqual({ ok: true, data: { zoneHead: answer.revision, replayed: false } });
    expect(s.statuses).toEqual([201]);
    if (!result.ok) throw new Error('Recorded publication refused');
    expect(reduceEditor(state, { type: 'published', ...result.data, revisionId: choice.revisionId }))
      .toMatchObject({ homeDocument: state.homeDocument, publishedRevisionId: state.basis!.revisionId,
        notice: { kind: 'published', replayed: false } });
  } finally { s.replay.dispose(); }
});

test('confirmed production review accepts the unchanged bundle and refuses a different home identity', async () => {
  const s = session();
  try {
    const state = opening().state;
    const selection = await readSavedPublicationSelection(zoneId, actor, {
      authoring: s.authoring, navigation: browserZoneNavigation(s.main), theme: browserZoneTheme(s.main),
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error('Recorded review refused');
    expect(selection.data.homeDocument).toBe(state.homeDocument);
    const review = stagePublicationReview(selection.data);
    expect(reviewedPublicationChoice(state, review)).toBeNull();
    const confirmed = confirmPublicationReview(review);
    expect(reviewedPublicationChoice({ ...state, homeDocument: zoneIri }, confirmed)).toBeNull();
    const choice = reviewedPublicationChoice(state, confirmed);
    if (!choice) throw new Error('Confirmed recorded review is publishable');
    expect(publicationWire(choice, actor)).toEqual(sample('publish-site-bundle').body);
    const answer = sample('publish-site-bundle').answer as { revision: string };
    expect(await s.authoring.publish(choice, actor, crypto.randomUUID(), zoneId))
      .toEqual({ ok: true, data: { zoneHead: answer.revision, replayed: false } });
    expect(s.statuses.at(-1)).toBe(201);
  } finally { s.replay.dispose(); }
});
