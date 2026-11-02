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
import { readNativeBoardChoices, type BoardIncomingPage } from '../src/community/setup-board-native';
import { setupBoardChoiceSource } from '../src/community/setup-board-picker';
import type { KernelClient } from '@rezics/client';

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
    schemes: async (input) => {
      inputs.push(input);
      return { schemes: [scheme], next: null };
    },
    concepts: async (input) => {
      inputs.push(input);
      return { concepts: [concept], next: null };
    },
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
      return Response.json(
        request.method === 'PUT' ? { realm: { ...realmRecording.realm, boardSchemeId: scheme.id } } : boardRecording,
      );
    },
  });
  const saved = await commandSetup(client, 'Bearer viewer', {
    step: 'scheme',
    key,
    realmId: realmRecording.realm.realmId,
    head: realmRecording.realm.headRevisionId,
    schemeId: pager.choose(scheme.id)!.id,
  });
  expect(saved.kind).toBe('realm');
  pager.search({ source: choices, kind: 'concept', schemeId: scheme.id, query: 'Intro' }, 0);
  await turn();
  expect(pager.choose(concept.id)).toEqual(concept);
  expect(pager.choose(scheme.id)).toBeNull();
  const created = await commandSetup(client, 'Bearer viewer', {
    step: 'board',
    key,
    realmId: realmRecording.realm.realmId,
    conceptId: pager.choose(concept.id)!.id,
    title: 'Start here',
    purpose: 'reviews',
    visibility: 'protected',
  });
  expect(created).toEqual({ kind: 'board', id: boardRecording.board.id });
  expect(inputs).toEqual([{ query: 'Reading' }, { schemeId: scheme.id, query: 'Intro' }]);
  expect(requests).toHaveLength(2);
  expect(new URL(requests[0]!.url).pathname).toBe(`/v1/realms/${realmRecording.realm.realmId}/boardScheme`);
  expect(requests[0]!.headers.get('if-match')).toBe(JSON.stringify(realmRecording.realm.headRevisionId));
  expect(await requests[1]!.json()).toEqual({
    title: 'Start here',
    conceptId: concept.id,
    purpose: 'reviews',
    visibility: 'protected',
  });
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer viewer')).toBe(true);
  pager.cancel();
});

test('search debounces, Next reads exactly one bounded page, and old query/source/scheme responses are hidden', async () => {
  const inputs: unknown[] = [];
  let page: BoardChoicePage | undefined;
  let finishOld!: (result: { concepts: readonly { id: string; label: string }[]; next: null }) => void;
  const old: BoardChoiceSource = {
    ...source,
    concepts: () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  };
  const current: BoardChoiceSource = {
    ...source,
    concepts: async (input) => {
      inputs.push(input);
      return { concepts: input.cursor ? [concept] : [scheme], next: input.cursor ? null : 'opaque-next' };
    },
  };
  const pager = new BoardChoicePager((next) => {
    page = next;
  });
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

test('retired Board page callbacks cannot page, retry or choose after cancellation or a new scope', async () => {
  const late = Promise.withResolvers<{ schemes: readonly { id: string; label: string }[]; next: string | null }>();
  const calls: string[] = [];
  const prior: BoardChoiceSource = {
    ...source,
    schemes: async () => {
      calls.push('prior');
      return late.promise;
    },
  };
  const current: BoardChoiceSource = {
    ...source,
    schemes: async () => {
      calls.push('current');
      return { schemes: [scheme], next: 'current-next' };
    },
  };
  const priorScope = { source: prior, kind: 'scheme' as const, schemeId: '', query: 'prior' };
  const currentScope = { source: current, kind: 'scheme' as const, schemeId: '', query: 'current' };
  let page: BoardChoicePage | undefined;
  const pager = new BoardChoicePager((value) => {
    page = value;
  });
  pager.search(priorScope, 0);
  await turn();
  expect(calls).toEqual(['prior']);
  pager.search(currentScope, 0);
  await turn();
  expect(page?.choices).toEqual([scheme]);
  expect(pager.choose(scheme.id, priorScope)).toBeNull();
  expect(pager.choose(scheme.id, currentScope)).toEqual(scheme);
  pager.cancel();
  pager.next(currentScope);
  pager.retry(currentScope);
  pager.restart(currentScope);
  expect(pager.choose(scheme.id, currentScope)).toBeNull();
  late.resolve({ schemes: [{ id: concept.id, label: 'Retired scheme' }], next: 'prior-next' });
  await turn();
  expect(calls).toEqual(['prior', 'current']);
  expect(page?.choices).toEqual([scheme]);
  pager.next(priorScope);
  pager.retry(priorScope);
  pager.restart(priorScope);
  expect(calls).toEqual(['prior', 'current']);
});

test('Board callbacks expire when source, scheme, or search text changes and later returns to the same values', async () => {
  const calls: string[] = [];
  const choices: BoardChoiceSource = {
    schemes: async ({ query }) => {
      calls.push(`scheme:${query}`);
      return { schemes: [scheme], next: 'opaque-next' };
    },
    concepts: async ({ schemeId, query }) => {
      calls.push(`concept:${schemeId}:${query}`);
      return { concepts: [concept], next: null };
    },
  };
  const pager = new BoardChoicePager(() => {});
  const sameScope = { source: choices, kind: 'scheme' as const, schemeId: '', query: 'same' };
  pager.search(sameScope, 0);
  await turn();
  const prior = { ...sameScope, version: pager.version() };

  pager.search({ ...sameScope, query: 'other' }, 0);
  await turn();
  pager.search(sameScope, 0);
  await turn();
  expect(pager.choose(scheme.id, prior)).toBeNull();
  pager.next(prior);
  expect(calls).toEqual(['scheme:same', 'scheme:other', 'scheme:same']);

  const current = { ...sameScope, version: pager.version() };
  expect(pager.choose(scheme.id, current)).toEqual(scheme);
  pager.search({ source: choices, kind: 'concept', schemeId: scheme.id, query: 'same' }, 0);
  await turn();
  expect(pager.choose(concept.id, current)).toBeNull();
  pager.cancel();
});

test('a missing or failed current source is unavailable, distinct from a successful empty page', async () => {
  await expect(unavailableBoardChoiceSource.schemes({ query: '' })).rejects.toBeInstanceOf(BoardChoiceUnavailable);
  let page: BoardChoicePage | undefined;
  let calls = 0;
  const choices: BoardChoiceSource = {
    ...source,
    schemes: async () => {
      if (++calls === 1) throw new BoardChoiceUnavailable();
      return { schemes: [], next: null };
    },
  };
  const pager = new BoardChoicePager((next) => {
    page = next;
  });
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
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push({ headers: Object.fromEntries(request.headers), body: await request.json() });
      return Response.json({ code: 'current_authority_refused' }, { status });
    },
  });
  const original = setupAttempt(
    null,
    {
      step: 'board',
      realmId: realmRecording.realm.realmId,
      conceptId: concept.id,
      title: 'Keep this draft',
      purpose: 'discussion',
      visibility: 'draft',
    },
    key,
  );
  expect(retainSetupAttempt(await commandSetup(client, 'Bearer viewer', original))).toBe(true);
  const retry = setupAttempt(original, { ...original, title: 'Changed' }, crypto.randomUUID());
  expect(retry).toBe(original);
  await commandSetup(client, 'Bearer viewer', retry);
  expect(seen[0]).toEqual(seen[1]);
  for (status of [403, 409, 422]) {
    const result = await commandSetup(client, 'Bearer viewer', original);
    expect(result).toEqual({
      kind: 'failure',
      reason: status === 403 ? 'denied' : status === 409 ? 'conflict' : 'invalid',
      status,
    });
    expect(retainSetupAttempt(result)).toBe(false);
  }
});

type SearchData = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type CatalogueHit = Extract<SearchData, { subjects: readonly unknown[] }>['subjects'][number];
const schemeHit = {
  id: scheme.id,
  type: 'skos:ConceptScheme',
  kind: 'subject',
  base: {
    id: scheme.id,
    kind: 'subject',
    kindLabel: { value: 'Subject', language: 'en' },
    title: { value: 'Current reading topics', language: 'en' },
    image: null,
    url: { id: scheme.id, label: null },
  },
  labels: { en: 'Catalogue label' },
  summary: {
    id: scheme.id,
    type: 'skos:ConceptScheme',
    types: ['skos:ConceptScheme'],
    label: { value: 'Summary label', language: 'en' },
    creativeWork: false,
    cover: null,
  },
  figure: {
    questionId: key,
    populationId: key,
    scale: { min: 1, max: 5, displayStep: 1 },
    count: 0,
    state: 'insufficient_data',
    mean: null,
    score: null,
  },
} satisfies CatalogueHit;
const memberLink = {
  subject: concept.id,
  property: 'skos:inScheme',
  statement: key,
  type: 'skos:Concept',
  label: 'Compatibility label',
  summary: {
    id: concept.id,
    type: 'skos:Concept',
    types: ['skos:Concept'],
    label: { value: 'Current introductions', language: 'en' },
    creativeWork: false,
    cover: null,
  },
} satisfies BoardIncomingPage['links'][number];

test('Bind board scheme picker to constrained native Search and incoming SKOS links', async () => {
  const requests: Request[] = [];
  const as_of = '2026-10-31T00:00:00.000Z';
  const client = createKernelClient('https://kernel.test', {
    headers: { 'accept-language': 'en' },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ subjects: [schemeHit], next: 'native-search-next', as_of });
    },
  });
  const native = setupBoardChoiceSource((input) => readNativeBoardChoices(client, 'Bearer viewer', ['en'], input));
  expect(await native.schemes({ query: '  ' })).toEqual({
    schemes: [{ id: scheme.id, label: 'Current reading topics' }],
    next: 'native-search-next',
    as_of,
  });
  const query = String.raw`Reading | -"themes" \ (literal*)`;
  await native.schemes({ query });
  await native.schemes({ query, cursor: 'native-search-next' });
  const bodies = await Promise.all(requests.map((request) => request.json()));
  expect(bodies[0]).toEqual({
    filter: { type: { in: ['skos:ConceptScheme'] } },
    sort: 'relevance',
    limit: 20,
    languages: ['en'],
  });
  expect(bodies[1]).toEqual({ ...bodies[0], text: String.raw`"Reading | -\"themes\" \\ (literal*)"` });
  expect(bodies[2]).toEqual({ ...bodies[1], cursor: 'native-search-next' });
  expect(requests.every((request) => new URL(request.url).pathname === '/v1/subjects:search')).toBe(true);
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer viewer')).toBe(true);
  expect(requests.every((request) => request.headers.get('accept-language') === 'en')).toBe(true);
});

test('incoming member summaries filter only the loaded page and retain native sparse-page continuation and freshness', async () => {
  const requests: Request[] = [];
  const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: false } as const;
  const client = createKernelClient('https://kernel.test', {
    headers: { 'accept-language': 'en' },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        links: requests.length > 1 ? [] : [memberLink, { ...memberLink, subject: scheme.id }],
        next: requests.length > 1 ? 'sparse-native-next' : 'incoming-native-next',
        freshness,
      });
    },
  });
  const native = setupBoardChoiceSource((input) => readNativeBoardChoices(client, 'Bearer viewer', ['en'], input));
  let page: BoardChoicePage | undefined;
  const pager = new BoardChoicePager((next) => {
    page = next;
  });
  pager.search({ source: native, kind: 'concept', schemeId: scheme.id, query: 'intro' }, 0);
  await turn();
  expect(page).toEqual({
    status: 'ready',
    choices: [{ id: concept.id, label: 'Current introductions' }],
    next: 'incoming-native-next',
    freshness,
  });
  pager.search({ source: native, kind: 'concept', schemeId: scheme.id, query: 'no name here' }, 0);
  expect(page?.choices).toEqual([]);
  expect(page?.next).toBe('incoming-native-next');
  expect(requests).toHaveLength(1);
  pager.next();
  await turn();
  expect(page).toEqual({ status: 'ready', choices: [], next: 'sparse-native-next', freshness });
  expect(requests).toHaveLength(2);
  const first = new URL(requests[0]!.url);
  expect(first.pathname).toBe(`/v1/subjects/${scheme.id}/links`);
  expect(Object.fromEntries(first.searchParams)).toEqual({
    property: 'skos:inScheme',
    type: 'skos:Concept',
    limit: '20',
  });
  expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({
    ...Object.fromEntries(first.searchParams),
    cursor: 'incoming-native-next',
  });
  expect(requests.every((request) => request.method === 'GET' && request.headers.get('accept-language') === 'en')).toBe(
    true,
  );
  pager.cancel();
});

test('native stale continuation restarts only on explicit retry; denied and unavailable are never empty success', async () => {
  const requests: Request[] = [];
  let status = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(
        status === 200
          ? { subjects: [schemeHit], next: 'stale-native-next', as_of: '2026-10-31T00:00:00.000Z' }
          : { code: status === 409 ? 'stale_cursor' : 'gate_denied' },
        { status },
      );
    },
  });
  const native = setupBoardChoiceSource((input) => readNativeBoardChoices(client, 'Bearer viewer', ['en'], input));
  let page: BoardChoicePage | undefined;
  const pager = new BoardChoicePager((next) => {
    page = next;
  });
  pager.search({ source: native, kind: 'scheme', schemeId: '', query: 'Reading' }, 0);
  await turn();
  status = 409;
  pager.next();
  await turn();
  expect(page).toEqual({ status: 'stale', choices: [], next: null });
  expect(pager.choose(scheme.id)).toBeNull();
  expect(requests).toHaveLength(2);
  status = 403;
  pager.retry();
  await turn();
  expect(page).toEqual({ status: 'denied', choices: [], next: null });
  const bodies = await Promise.all(requests.map((request) => request.json()));
  expect(bodies[1]).toEqual({ ...bodies[0], cursor: 'stale-native-next' });
  expect(bodies[2]).toEqual(bodies[0]);
  status = 503;
  pager.retry();
  await turn();
  expect(page).toEqual({ status: 'unavailable', choices: [], next: null });
  expect(await readNativeBoardChoices(client, '', ['en'], { kind: 'concept', schemeId: scheme.id, query: '' })).toEqual(
    { kind: 'failure', reason: 'denied', status: 401 },
  );
  expect(requests).toHaveLength(4);
  pager.cancel();
});
