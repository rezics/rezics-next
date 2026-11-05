import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { Value } from 'typebox/value';
import type { OwnVoteEntry, OwnVotesPage } from '../../../services/kernel/src/rating/own-votes-page.ts';
import {
  indexOwnVotes,
  ownVotesCursor,
  removeOwnVote,
  replaceOwnVote,
  votePairKey,
} from '../src/ratings/own-votes/inventory';

const accountId = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
const terminalId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
function entry(targetId: string, questionId: string, units = 0): OwnVoteEntry {
  const path = `/v1/subjects/${targetId}/ratings/${questionId}/vote`;
  return {
    targetId,
    questionId,
    subject: {
      id: terminalId,
      type: 'work',
      types: ['work'],
      label: { value: 'Same summary', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: '/v1/subjects/admitted',
    question: {
      id: questionId,
      revision: 1,
      label: 'Question',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units, revision: 1, at: '2026-10-01T00:00:00.000Z' },
    actions: { state: 'editable', put: path, clear: path, readback: path },
  };
}
const page = (votes: OwnVoteEntry[], next: string | null = null): OwnVotesPage => ({
  viewer: { accountId },
  votes,
  next,
});

test('bounded index keeps original pairs distinct when admitted summaries share one terminal identity', () => {
  for (const count of [1, 10, 20]) {
    const votes = Array.from({ length: count }, (_, index) => entry(`b${index}`, `q${index}`));
    const indexed = indexOwnVotes(page(votes));
    expect(indexed.size).toBe(count);
    expect(indexed.get(votePairKey(votes.at(-1)!))).toBe(votes.at(-1));
    expect(votes[0]!.own.units).toBe(0);
  }
  const sameSummary = [entry('source-a', 'question-a'), entry('source-b', 'question-a')];
  expect(indexOwnVotes(page(sameSummary)).size).toBe(2);
  expect(() => indexOwnVotes(page([sameSummary[0]!, sameSummary[0]!]))).toThrow();
});

test('cursor bytes and page frontier survive sparse pages, same-key edits and clear', () => {
  const next = 'sealed/+opaque=bytes';
  expect(ownVotesCursor(next)).toEqual({ valid: true, cursor: next });
  expect(ownVotesCursor('x'.repeat(4097))).toEqual({ valid: false });
  const first = entry('source-a', 'question-a');
  const second = entry('source-b', 'question-b');
  const current = page([first, second], next);
  const updated = replaceOwnVote(current, { ...first, own: { ...first.own, units: 8 } });
  expect(updated.votes.map(votePairKey)).toEqual(current.votes.map(votePairKey));
  expect(updated.next).toBe(next);
  const cleared = removeOwnVote(updated, first);
  expect(cleared.votes).toEqual([second]);
  expect(cleared.next).toBe(next);
  expect(page([], next).next).toBe(next);
});

// Exercise the real schema/action graph in Vite's module runner; only request/session boundaries are supplied.
let runner: Awaited<ReturnType<typeof createServer>>;
let actions: typeof import('../src/ratings/own-votes/actions');
const contentLoads: string[] = [];
const boundary = '\0own-votes-request-boundary';
const nativeFetch = globalThis.fetch;
const requestBoundary = `
  export function createServerFn() {
    let validate;
    const chain = {
      validator(next) { validate = next; return chain; },
      handler(run) { return input => run({ data: validate(input.data) }); }
    };
    return chain;
  }
  export const getRequest = () => new Request('https://site.test/en/library/ratings');
  export const setResponseHeader = () => {};
  export const requestLocale = () => 'en';
  export const prepareSession = async () => false;
  export const sessionSubject = () => '${accountId}';
  export const viewerCredential = () => 'Bearer admitted';
  export const env = { KERNEL_ORIGIN: 'https://kernel.test' };
`;
beforeAll(async () => {
  runner = await createServer({
    configFile: false,
    root: resolve(import.meta.dir, '..'),
    cacheDir: resolve(import.meta.dir, '../../../.temp/own-votes-schema-runtime'),
    ssr: { noExternal: ['@tanstack/react-start', /^@tanstack\/react-start\//, '@rezics/client'] },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
    plugins: [
      {
        name: 'own-votes-request-boundary',
        enforce: 'pre',
        resolveId(id, importer) {
          if (
            id.startsWith('@tanstack/react-start') ||
            id === 'cloudflare:workers' ||
            (importer?.endsWith('/ratings/own-votes/actions.ts') &&
              (id === '../../session/request' || id === '../../kernel/client'))
          )
            return boundary;
        },
        load(id) {
          if (id.includes('/services/kernel/src/content/')) contentLoads.push(id);
          if (id === boundary) return requestBoundary;
        },
      },
    ],
  });
  actions = await runner.ssrLoadModule(resolve(import.meta.dir, '../src/ratings/own-votes/actions.ts'));
});
afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await runner?.close();
});

test('the real own-votes consumer loads in the Web module runner without Content and shares strict native schemas', async () => {
  expect(contentLoads).toEqual([]);
  const schemas = await runner.ssrLoadModule(
    resolve(import.meta.dir, '../../../services/kernel/src/rating/own-votes-schemas.ts'),
  );
  const leaf = await runner.ssrLoadModule(
    resolve(import.meta.dir, '../../../services/kernel/src/rating/vote-response-schemas.ts'),
  );
  const rowSchema = schemas.OwnVotesPageSchema.properties.votes.items;
  expect(rowSchema.properties.question).toBe(leaf.RatingQuestionResponseSchema);
  expect(rowSchema.properties.own).toBe(leaf.RatingVoteResponseSchema);
  const vote = entry('b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', accountId);
  expect(Value.Check(schemas.OwnVotesPageSchema, page([vote]))).toBe(true);
  expect(Value.Check(schemas.OwnVotesPageSchema, page(Array(21).fill(vote)))).toBe(false);
  expect(Value.Check(schemas.OwnVoteActionsSchema, { ...vote.actions, unexpected: true })).toBe(false);
  expect(Value.Check(leaf.RatingQuestionResponseSchema, { ...vote.question, revision: 0 })).toBe(false);
});

test('native denied/admitted responses keep strict page admission and the original command/readback identity', async () => {
  const vote = entry('b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', accountId);
  const calls: Request[] = [];
  let status = 403;
  let response: unknown = page([vote], 'next/+sealed=');
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json(new URL(request.url).pathname === '/v1/me/rating-votes' ? response : vote.own, {
        status,
        headers: { 'rezics-session-token': 'readback-session' },
      });
    },
    { preconnect: nativeFetch.preconnect.bind(nativeFetch) },
  );
  const read = () => actions.readOwnVotesForViewer({ data: { cursor: 'original/+sealed=' } });
  expect(await read()).toMatchObject({ state: 'denied', page: null });
  status = 200;
  expect(await read()).toMatchObject({ state: 'ready', page: response, cursor: 'original/+sealed=' });
  for (const malformed of [
    { ...page([vote]), viewer: { accountId: terminalId } },
    page(Array(21).fill(vote)),
    page([vote], 'x'.repeat(4097)),
    page([{ ...vote, actions: { ...vote.actions, unexpected: true } }]),
    page([{ ...vote, question: { ...vote.question, id: terminalId } }]),
    page([{ ...vote, actions: { state: 'editable', put: '/other', clear: '/other', readback: '/other' } }]),
  ]) {
    response = malformed;
    expect(await read()).toMatchObject({ state: 'unavailable', page: null });
  }
  const { createOwnVoteIntent } = await import('../src/ratings/own-votes/intent');
  const intent = createOwnVoteIntent(accountId, vote, 'PUT', 2);
  calls.length = 0;
  expect(await actions.executeOwnVoteIntent({ data: intent })).toMatchObject({
    kind: 'acknowledged',
    readback: { kind: 'current', units: 0 },
  });
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['PUT', intent.path],
    ['GET', intent.path],
  ]);
  expect(calls[0]!.headers.get('idempotency-key')).toBe(intent.key);
  expect(await calls[0]!.json()).toEqual({ units: 2 });
  expect(calls[1]!.headers.get('rezics-session-token')).toBe('readback-session');
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer admitted')).toBe(true);
});
