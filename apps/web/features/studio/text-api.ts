import { browserMainApi } from '../api/browser.ts';
import type { SaveOutcome } from './autosave.ts';
import { idOf, type MainClient } from './types.ts';

// The browser side of Studio's writing: a Work's text in one language is a
// text contribution (`services/main/src/routes/contributions.ts`). The first
// save creates it; later saves are edits on the draft head they were typed on.
// Every command acts as the Studio Agent and carries its own idempotency key.

type Failure = { status: number; value?: unknown };

const code = (error: Failure) => (typeof error.value === 'object' && error.value !== null && 'code' in error.value
  ? String((error.value as { code: unknown }).code) : '');

/** Main's answer to a save, as the autosave machine reacts to it. */
export function saveOutcomeOf(error: Failure): SaveOutcome {
  // No HTTP status: the request never got an answer (the network failed under it).
  if (!(error.status >= 100)) return { kind: 'offline' };
  if (error.status === 409 && code(error) !== 'idempotency_conflict') return { kind: 'conflict' };
  if (error.status === 401 || error.status === 403) return { kind: 'denied' };
  if (error.status === 408 || error.status === 429 || error.status >= 500) return { kind: 'failed', retryable: true };
  return { kind: 'failed', retryable: false };
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export interface TextTarget { actingSubject: string; work: string; language: string }

/**
 * Saves a text: creates the Agent's text for this Work and language on the
 * first save, edits it on `expectedHead` afterwards. `onCreated` hands back the
 * new text's identity so later saves edit it.
 */
export async function saveText(target: TextTarget, text: string | null, body: string, expectedHead: string | null,
  key: string, onCreated: (text: string) => void, main: MainClient = browserMainApi()): Promise<SaveOutcome> {
  if (offline()) return { kind: 'offline' };
  const headers = { 'idempotency-key': key };
  if (!text) {
    const created = await main.v1.contributions.post({ profile: 'text-contribution-v1', work: target.work,
      language: target.language, body, actingSubject: target.actingSubject }, { headers });
    if (created.error) return saveOutcomeOf(created.error);
    if (!created.data || 'operationId' in created.data) return { kind: 'failed', retryable: true };
    onCreated(created.data.contribution);
    return { kind: 'saved', head: created.data.draftRevision };
  }
  if (!expectedHead) return { kind: 'conflict' };
  const edited = await main.v1['contribution-edits'].post({ profile: 'text-contribution-v1', contribution: text,
    expectedHead, body, actingSubject: target.actingSubject }, { headers });
  if (edited.error) return saveOutcomeOf(edited.error);
  if (!edited.data || 'operationId' in edited.data) return { kind: 'failed', retryable: true };
  return { kind: 'saved', head: edited.data.draftRevision };
}

/**
 * The text's current draft head and body, for comparing after a conflict. Main
 * has no direct head read, so this scans the Agent's text list (five pages at
 * most); null when Main does not let this Agent list its texts.
 */
export async function readLatest(actingSubject: string, text: string, main: MainClient = browserMainApi()):
  Promise<{ head: string; body: string } | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const listed = await main.v1.me.contributions.get({ query: { actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } });
    if (!listed.data) return null;
    const mine = listed.data.items.find(item => item.id === text);
    if (mine) {
      const draft = await main.v1.contributions({ contribution: idOf(text) }).drafts({ revision: idOf(mine.revision) })
        .get({ query: { actingSubject } });
      return draft.data ? { head: mine.revision, body: draft.data.body } : null;
    }
    if (!listed.data.nextCursor) return null;
    cursor = listed.data.nextCursor;
  }
  return null;
}

export type StepOutcome = 'done' | 'denied' | 'stale' | 'pending' | 'failed';

const stepOf = (error: Failure): StepOutcome => error.status === 401 || error.status === 403 ? 'denied'
  : error.status === 409 ? 'stale' : 'failed';

export interface Publication { publicationDecision: string; selectedDraft: string }

/** Publishes the draft at `head` for everyone to read, as an original contribution. */
export async function publishText(input: { actingSubject: string; text: string; head: string;
  expectedPublicationHead: string | null; key: string }, main: MainClient = browserMainApi()):
  Promise<{ outcome: StepOutcome; publication?: Publication }> {
  const response = await main.v1['contribution-publications'].post({ profile: 'text-publication-v1',
    contribution: input.text, expectedDraftHead: input.head, expectedPublicationHead: input.expectedPublicationHead,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: input.actingSubject },
  { headers: { 'idempotency-key': input.key } });
  if (response.error) return { outcome: stepOf(response.error) };
  if (!response.data || 'operationId' in response.data) return { outcome: 'pending' };
  return { outcome: 'done', publication: { publicationDecision: response.data.publicationDecision,
    selectedDraft: response.data.selectedDraft } };
}

/** Makes a publication the text readers open for the Work (its Main Version's default selection). */
export async function selectMainText(input: { actingSubject: string; work: string; mainVersion: string; text: string;
  publication: Publication; key: string }, main: MainClient = browserMainApi()): Promise<StepOutcome> {
  const current = await main.v1['main-versions']({ mainVersion: idOf(input.mainVersion) }).selection.get({ query: {} });
  if (current.error && current.error.status !== 404) return 'failed';
  const response = await main.v1['publication-selections'].post({ profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: input.mainVersion }, work: input.work, contribution: input.text,
    publicationDecision: input.publication.publicationDecision, expectedSelectionHead: current.data?.selection ?? null,
    selectionBasis: 'main-maintainer', actingSubject: input.actingSubject }, { headers: { 'idempotency-key': input.key } });
  if (response.error) return stepOf(response.error);
  return response.data && !('operationId' in response.data) ? 'done' : 'pending';
}

/** Submits the publication to one Realm's review; each Realm is its own command and receipt. */
export async function submitToRealm(input: { actingSubject: string; realm: string; work: string; mainVersion: string;
  text: string; publication: Publication; key: string }, main: MainClient = browserMainApi()): Promise<StepOutcome> {
  const response = await main.v1.realms({ realm: idOf(input.realm) }).submissions.post({ actingSubject: input.actingSubject,
    kind: 'contribution', work: input.work, mainVersion: input.mainVersion, contribution: input.text,
    publicationDecision: input.publication.publicationDecision, selectedDraft: input.publication.selectedDraft,
    correctionOf: null }, { headers: { 'idempotency-key': input.key } });
  if (response.error) return response.error.status === 503 && code(response.error) === 'dependency_unavailable'
    ? 'denied' : stepOf(response.error);
  return 'done';
}
