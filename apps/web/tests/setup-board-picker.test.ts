import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  BoardChoicePager,
  BoardChoiceUnavailable,
  currentBoardConcept,
  unavailableBoardChoiceSource,
  type BoardChoicePage,
  type BoardChoiceSource,
} from '../src/community/setup-board-picker';
import { commandSetup, retainSetupAttempt, setupAttempt } from '../src/community/space-setup';
import realmRecording from '../src/kernel/recorded/realm.json';
import boardRecording from '../src/kernel/recorded/board-realm.json';

const scheme = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000003', label: 'Reading topics' };
const concept = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000004', label: 'Introductions' };
const key = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const turn = () => new Promise((resolve) => setTimeout(resolve, 5));
const source: BoardChoiceSource = {
  schemes: async () => ({ schemes: [scheme], next: null }),
  concepts: async () => ({ concepts: [concept], next: null }),
};

test('Guided board setup chooses installed SKOS scheme and exact member concept', async () => {
  const inputs: unknown[] = [];
  const requests: Request[] = [];
  const choices: BoardChoiceSource = {
    schemes: async (input) => { inputs.push(input); return { schemes: [scheme], next: null }; },
    concepts: async (input) => { inputs.push(input); return { concepts: [concept], next: null }; },
  };
  const pager = new BoardChoicePager(() => {});
  pager.search({ source: choices, kind: 'scheme', schemeId: '', query: 'Reading' }, 0);
  await turn();
  expect(pager.choose(scheme.id)).toEqual(scheme);
  expect(pager.choose('arbitrary-id')).toBeNull();
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return Response.json(request.method === 'PUT'
        ? { realm: { ...realmRecording.realm, boardSchemeId: scheme.id } }
        : boardRecording);
    },
  });
  const saved = await commandSetup(client, 'Bearer viewer', {
    step: 'scheme', key, realmId: realmRecording.realm.realmId,
    head: realmRecording.realm.headRevisionId, schemeId: pager.choose(scheme.id)!.id,
  });
  expect(saved.kind).toBe('realm');
  pager.search({ source: choices, kind: 'concept', schemeId: scheme.id, query: 'Intro' }, 0);
  await turn();
  expect(pager.choose(concept.id)).toEqual(concept);
  expect(pager.choose(scheme.id)).toBeNull();
  const created = await commandSetup(client, 'Bearer viewer', {
    step: 'board', key, realmId: realmRecording.realm.realmId, conceptId: pager.choose(concept.id)!.id,
    title: 'Start here', purpose: 'reviews', visibility: 'protected',
  });
  expect(created).toEqual({ kind: 'board', id: boardRecording.board.id });
  expect(inputs).toEqual([{ query: 'Reading' }, { schemeId: scheme.id, query: 'Intro' }]);
  expect(requests).toHaveLength(2);
  expect(new URL(requests[0]!.url).pathname).toBe(`/v1/realms/${realmRecording.realm.realmId}/boardScheme`);
  expect(requests[0]!.headers.get('if-match')).toBe(JSON.stringify(realmRecording.realm.headRevisionId));
  expect(await requests[1]!.json()).toEqual({ title: 'Start here', conceptId: concept.id, purpose: 'reviews', visibility: 'protected' });
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer viewer')).toBe(true);
  pager.cancel();
});

test('search debounces, Next reads exactly one bounded page, and old query/source/scheme responses are hidden', async () => {
  const inputs: unknown[] = [];
  let page: BoardChoicePage | undefined;
  let finishOld!: (result: { concepts: readonly { id: string; label: string }[]; next: null }) => void;
  const old: BoardChoiceSource = { ...source, concepts: () => new Promise((resolve) => { finishOld = resolve; }) };
  const current: BoardChoiceSource = {
    ...source,
    concepts: async (input) => {
      inputs.push(input);
      return { concepts: input.cursor ? [concept] : [scheme], next: input.cursor ? null : 'opaque-next' };
    },
  };
  const pager = new BoardChoicePager((next) => { page = next; });
  pager.search({ source: old, kind: 'concept', schemeId: 'old-scheme', query: '' }, 0);
  await turn();
  pager.search({ source: current, kind: 'concept', schemeId: scheme.id, query: 'I' }, 10);
  pager.search({ source: current, kind: 'concept', schemeId: scheme.id, query: 'Intro' }, 0);
  expect(page?.choices).toEqual([]);
  expect(pager.choose(concept.id)).toBeNull();
  finishOld({ concepts: [concept], next: null });
  await turn();
  expect(page?.choices).toEqual([scheme]);
  expect(inputs).toHaveLength(1);
  pager.next();
  pager.next();
  await turn();
  expect(inputs).toEqual([
    { schemeId: scheme.id, query: 'Intro' },
    { schemeId: scheme.id, query: 'Intro', cursor: 'opaque-next' },
  ]);
  expect(page?.choices).toEqual([concept]);
  pager.next();
  await turn();
  expect(inputs).toHaveLength(2);
  pager.search({ source: old, kind: 'concept', schemeId: 'other-scheme', query: '' }, 0);
  await turn();
  pager.cancel();
  finishOld({ concepts: [scheme], next: null });
  await turn();
  expect(page?.status).toBe('loading');
});

test('a missing or failed current source is unavailable, distinct from a successful empty page', async () => {
  await expect(unavailableBoardChoiceSource.schemes({ query: '' })).rejects.toBeInstanceOf(BoardChoiceUnavailable);
  let page: BoardChoicePage | undefined;
  let calls = 0;
  const choices: BoardChoiceSource = { ...source, schemes: async () => {
    if (++calls === 1) throw new BoardChoiceUnavailable();
    return { schemes: [], next: null };
  } };
  const pager = new BoardChoicePager((next) => { page = next; });
  pager.search({ source: choices, kind: 'scheme', schemeId: '', query: '' }, 0);
  await turn();
  expect(page).toEqual({ status: 'unavailable', choices: [], next: null });
  pager.retry();
  await turn();
  expect(page).toEqual({ status: 'ready', choices: [], next: null });
  pager.cancel();
});

test('a changed saved scheme invalidates the pending topic without changing its identity or other board drafts', () => {
  const selection = { schemeId: scheme.id, choice: concept };
  expect(currentBoardConcept(selection, scheme.id)).toBe(selection);
  expect(currentBoardConcept(selection, 'different-scheme')).toBeNull();
  expect(currentBoardConcept(selection, null)).toBeNull();
  expect(selection.choice).toEqual(concept);
});

test('current native denial or membership conflict overrides display selection; uncertain retries preserve the exact command', async () => {
  let status = 503;
  const seen: { headers: Record<string, string>; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const request = new Request(input, init);
    seen.push({ headers: Object.fromEntries(request.headers), body: await request.json() });
    return Response.json({ code: 'current_authority_refused' }, { status });
  } });
  const original = setupAttempt(null, {
    step: 'board', realmId: realmRecording.realm.realmId, conceptId: concept.id,
    title: 'Keep this draft', purpose: 'discussion', visibility: 'draft',
  }, key);
  expect(retainSetupAttempt(await commandSetup(client, 'Bearer viewer', original))).toBe(true);
  const retry = setupAttempt(original, { ...original, title: 'Changed' }, crypto.randomUUID());
  expect(retry).toBe(original);
  await commandSetup(client, 'Bearer viewer', retry);
  expect(seen[0]).toEqual(seen[1]);
  for (status of [403, 409, 422]) {
    const result = await commandSetup(client, 'Bearer viewer', original);
    expect(result).toEqual({ kind: 'failure', reason: status === 403 ? 'denied' : status === 409 ? 'conflict' : 'invalid', status });
    expect(retainSetupAttempt(result)).toBe(false);
  }
});
