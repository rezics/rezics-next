import { expect, test } from 'vitest';
import { serializeDocument } from '@rezics/document';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import navigationAndTheme from '../../../../tests/qa/fixtures/outcomes/zone/navigation-and-theme.json';
import publication from '../../../../tests/qa/fixtures/outcomes/zone/publication.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, browserZoneNavigation, browserZoneTheme } from './api.ts';
import { authoringModel, canPublish, draftChoice, draftWire, publicationChoice, publicationWire, reduceEditor, type DraftWire, type EditorState } from './model.ts';
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

function capturedDraft(label: string, state: EditorState): EditorState {
  const body = sample(label).body as DraftWire;
  expect(body.resourceId).toBe(state.homeDocument);
  return { ...state, variantId: body.variantId, language: body.language, direction: body.direction,
    expectedHead: body.expectedHead, value: serializeDocument(body.document), embeds: body.embeds };
}

function savedDraft(label: string, state: EditorState): EditorState {
  const captured = capturedDraft(label, state);
  const answer = sample(label).answer as { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string }; replayed: boolean };
  return reduceEditor(captured, { type: 'saved', captured: captured.value, savedValue: captured.value,
    basis: { revisionId: answer.revisionId, byteDigest: answer.byteDigest, contentEpoch: answer.sourcePosition.dataEpoch }, replayed: answer.replayed });
}

function publicationState() {
  return savedDraft('save-home-draft-over-head', savedDraft('save-home-draft', opening().state));
}

function opening(showcase: unknown = editor.answer) {
  const model = authoringModel(showcase, sample('draft-navigation').answer, zoneId, 'Recorded site');
  if (!model) throw new Error('Authorized recorded editor must load');
  return model;
}

function session() {
  const replay = recordedFetch(record, 'owner', [{ label: 'mount-target-work', state: 'error' }, ...[
    'showcase-editor', 'draft-navigation', 'draft-navigation-editor', 'draft-configuration',
    'mount-target-collection-name', 'save-home-draft', 'save-home-draft-over-head', 'publish-site-bundle',
  ].map(label => ({ label, state: 'populated' as const }))], { pathPrefix: BFF_PREFIX });
  const statuses: number[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await replay.fetcher(input, init);
    statuses.push(answer.status);
    return answer;
  }) as typeof fetch;
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  return { replay, main, statuses, authoring: browserZoneAuthoring(main) };
}

test('prepared home identity is distinct from the Zone and captured with the exact saved Content basis', () => {
  const state = publicationState();
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
    const state = publicationState();
    const choice = publicationChoice(state);
    if (!choice) throw new Error('Saved recorded home is publishable');
    const result = await s.authoring.publish(choice, actor, crypto.randomUUID(), zoneId);
    const answer = sample('publish-site-bundle').answer as { revision: string };
    expect(result).toEqual({ ok: true, data: { zoneHead: answer.revision, replayed: false, receipt: answer } });
    expect(s.statuses).toEqual([201]);
    if (!result.ok) throw new Error('Recorded publication refused');
    expect(reduceEditor(state, { type: 'published', ...result.data, revisionId: choice.revisionId }))
      .toMatchObject({ homeDocument: state.homeDocument, publishedRevisionId: state.basis!.revisionId,
        publishedReceipt: answer, notice: { kind: 'published', replayed: false } });
  } finally { s.replay.dispose(); }
});

test('confirmed production review accepts the unchanged bundle and refuses a different home identity', async () => {
  const s = session();
  try {
    const state = publicationState();
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
      .toEqual({ ok: true, data: { zoneHead: answer.revision, replayed: false, receipt: answer } });
    expect(s.statuses.at(-1)).toBe(201);
  } finally { s.replay.dispose(); }
});

test('production saves accept both unchanged draft commands and carry their exact basis into publication', async () => {
  const s = session();
  try {
    let state: EditorState = { ...opening().state, savedValue: null, basis: null };
    for (const label of ['save-home-draft', 'save-home-draft-over-head']) {
      const edited = capturedDraft(label, state);
      const choice = draftChoice(edited, actor);
      expect(draftWire(choice)).toEqual(sample(label).body);
      const result = await s.authoring.saveDraft(draftWire(choice), crypto.randomUUID());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Recorded draft refused');
      const answer = sample(label).answer as { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
      expect(result.data).toEqual({ revisionId: answer.revisionId, byteDigest: answer.byteDigest,
        contentEpoch: answer.sourcePosition.dataEpoch, replayed: false });
      state = reduceEditor(edited, { type: 'saved', captured: choice.captured, savedValue: choice.savedValue,
        basis: result.data, replayed: result.data.replayed });
      expect(state.notice).toEqual({ kind: 'saved', replayed: false });
    }
    const choice = publicationChoice(state);
    if (!choice) throw new Error('Recorded saved home is publishable');
    expect(publicationWire(choice, actor)).toEqual(sample('publish-site-bundle').body);
    const published = await s.authoring.publish(choice, actor, crypto.randomUUID(), zoneId);
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error('Recorded saved publication refused');
    expect(reduceEditor(state, { type: 'published', ...published.data }).publishedReceipt)
      .toEqual(sample('publish-site-bundle').answer);
    expect(s.statuses).toEqual([201, 201, 201]);
  } finally { s.replay.dispose(); }
});

test('production publication retains the exact acknowledged receipt after heads move and the recorded refusal title and code', async () => {
  const record = publication as AnswerRecord;
  for (const label of ['publication-acknowledgement', 'original-receipt-replay', 'legacy-home-refused',
    'receipt-body-conflict', 'stale-publication-refused']) {
    const sample = record.personas.owner.find(item => item.label === label)!;
    const replay = recordedFetch(record, 'owner', [{ label, state: sample.status >= 400 ? 'error' : 'populated' }], { pathPrefix: BFF_PREFIX });
    try {
      const authoring = browserZoneAuthoring(browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher }));
      const body = sample.body as { pages: { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }[];
        expectedHead: string; routesRevision: string; navigationRevision: string; actingSubject: string };
      const result = await authoring.publish({ ...body.pages[0]!, zoneHead: body.expectedHead,
        routesRevision: body.routesRevision, navigationRevision: body.navigationRevision }, body.actingSubject, crypto.randomUUID(), zoneIdFromRecordedPath(sample.path));
      if (sample.status < 400) {
        const answer = sample.answer as { revision: string; replayed: boolean };
        expect(result).toEqual({ ok: true, data: { zoneHead: answer.revision, replayed: answer.replayed, receipt: sample.answer } });
        if (!result.ok) throw new Error('Recorded receipt refused');
        const published = reduceEditor(publicationState(), { type: 'published', ...result.data });
        const changed = reduceEditor(published, { type: 'heads', zoneHead: opening().state.zoneHead,
          navigationRevision: opening().state.navigationRevision });
        expect(changed.publishedReceipt).toEqual(sample.answer);
      } else {
        const answer = sample.answer as { title: string; code: string };
        expect(result).toMatchObject({ ok: false, problem: { title: answer.title, code: answer.code } });
        if (result.ok) throw new Error('Recorded refusal accepted');
        const refused = reduceEditor(publicationState(), result.failure === 'stale'
          ? { type: 'publish-stale', problem: result.problem }
          : { type: 'failed', failure: result.failure, problem: result.problem });
        expect(refused.notice).toMatchObject({ problem: { title: answer.title, code: answer.code } });
      }
    } finally { replay.dispose(); }
  }
});
