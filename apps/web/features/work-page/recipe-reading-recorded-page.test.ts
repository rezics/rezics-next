import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { browserMainApi } from '../api/browser.ts';
import { serverFetch } from '../api/server-fetch.ts';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recipes from '../../../../tests/qa/fixtures/outcomes/recipes/read-a-recipe.json';
import { mainApiWithToken } from '../api/main.ts';
import { formatMeasure, formatQuantity } from '../recipe-editor/quantity.ts';
import { recipeMethodReady, type Instruction } from '../recipe-editor/instructions.ts';
import { instructionVisitIdentity, instructionVisitTransport } from '../recipe-editor/instruction-recorded-fixture.ts';
import { appendRecipePage } from '../recipe-editor/pages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import type { RecordedProblem } from './books-language-recorded-page.ts';
import {
  loadRecipeBody,
  loadRecipeIdentity,
  recipePageReader,
  recipeMethodAvailable,
  recipeReadingReads,
  type RecipeIdentity,
} from './recipe-reading-recorded-page.ts';
import type { AgentCreditPage, RecipeWorkPage, WorkHeader } from './types.ts';
import { englishMessages } from './messages.ts';
import { recipeRegion, recipeWorkFrame, recipeWorkOverview } from './recipe-reading-recorded-page.tsx';
import { EVERYONE } from './route.ts';
import { nutrientNames, nutritionPage } from './types/recipe-nutrition.fixtures.ts';

const record = recipes as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const disposals: (() => void)[] = [];

test('cooking mode requires a complete loaded method, retaining unavailable native selections', () => {
  const occurrence = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const legacy = { occurrences: [{ occurrence, role: 'step', qualifier: {
    type: 'recipe-step', instructionText: { value: 'Mix the sauce.' },
  } }], instructions: [] as Instruction[] };
  expect(recipeMethodReady(null)).toBe(false);
  expect(recipeMethodReady({ occurrences: [] })).toBe(false);
  expect(recipeMethodReady({ ...legacy, next: 'later-method-page' })).toBe(false);
  expect(recipeMethodReady(legacy)).toBe(true);
  const selected: Instruction = { occurrence, reference: { target: occurrence,
    selector: { grain: 'representation', revision: occurrence, representation: occurrence } }, status: 'unavailable' };
  // A native selected instruction takes precedence over an older qualifier on the same occurrence.
  expect(recipeMethodReady({ ...legacy, instructions: [selected] })).toBe(false);
  expect(recipeMethodReady({ ...legacy, instructions: [{ ...selected, status: 'available' }] })).toBe(false);
  expect(recipeMethodReady({ ...legacy, instructions: [{ ...selected, status: 'available', text: 'Mix.' }] })).toBe(true);
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const published: RecordedSelection[] = [
  { label: 'work-header', state: 'populated' },
  { label: 'page-projection', state: 'populated' },
  { label: 'agent-credits', state: 'populated' },
  { label: 'work-credits', state: 'populated' },
  { label: 'recipe-notes-empty', state: 'error' },
  { label: 'author-works', state: 'populated' },
  { label: 'recipe-start', state: 'populated' },
  { label: 'recipe-continuation', state: 'populated' },
  { label: 'recipe-scaled-start', state: 'populated' },
  { label: 'recipe-scaled-page-2', state: 'populated' },
];

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function recordedId(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )?.[0];
  if (!id) throw new Error(`Recorded path has no id: ${path}`);
  return id;
}

function actingSubjectOf(path: string): string | null {
  return new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function problemOf(value: unknown): RecordedProblem {
  if (!value || typeof value !== 'object') throw new Error('Recorded problem is empty');
  const problem = value as { type?: unknown; title?: unknown; code?: unknown; status?: unknown };
  if (typeof problem.type !== 'string' || typeof problem.title !== 'string'
    || typeof problem.code !== 'string' || typeof problem.status !== 'number') {
    throw new Error('Recorded problem is incomplete');
  }
  return { type: problem.type, title: problem.title, code: problem.code, status: problem.status };
}

function asRecipe(value: unknown): RecipeWorkPage {
  return value as RecipeWorkPage;
}

function client(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections);
  disposals.push(replay.dispose);
  return mainApiWithToken(undefined, { fetcher: replay.fetcher });
}

function ready(identity: RecipeIdentity): asserts identity is Extract<RecipeIdentity, { kind: 'ready' }> {
  if (identity.kind !== 'ready') throw new Error(`Recipe identity was ${identity.kind} (${identity.failure})`);
}

test('a transient unavailable Recipe read is recovered with the identical actor and selection', async () => {
  const requests: string[] = [];
  const start = sample('owner', 'recipe-start');
  const main = mainApiWithToken(undefined, { fetcher: Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return requests.length === 1
      ? Response.json({ code: 'work_read_unavailable' }, { status: 503 }) : Response.json(start.answer);
  }, { preconnect: fetch.preconnect }) });
  const answer = await recipePageReader({ main, actingSubject: actingSubjectOf(start.path) }, start.path)({ cursor: 'exact-cursor' });
  expect(answer.error).toBeNull();
  expect(answer.data).toEqual(asRecipe(start.answer));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(new URL(requests[0]!).searchParams.get('cursor')).toBe('exact-cursor');
});

test.each([401, 403, 404, 409, 503])('a definitive Recipe refusal stays visible without retry (%s)', async status => {
  let calls = 0;
  const main = mainApiWithToken(undefined, { fetcher: Object.assign(async () => {
    calls++;
    return Response.json({ code: 'specific_refusal' }, { status });
  }, { preconnect: fetch.preconnect }) });
  const answer = await recipePageReader({ main }, '/v1/recipes/works/00000000-0000-4000-8000-000000000001')({});
  expect(answer.error?.status).toBe(status);
  expect(calls).toBe(1);
});

test('each persona reads the published recipe, its next page and a scaled page', async () => {
  const draft = sample('owner', 'private-draft-preview');
  expect(draft.method).toBe('GET');
  expect(new URL(draft.path, 'https://recorded.invalid').pathname).toContain('/v1/compositions/');
  const draftRevision = (draft.answer as { revision?: unknown }).revision;
  for (const persona of personas) {
    const header = sample(persona, 'work-header');
    const actingSubject = actingSubjectOf(header.path);
    const start = asRecipe(sample(persona, 'recipe-start').answer);
    const continuation = asRecipe(sample(persona, 'recipe-continuation').answer);
    const scaled = asRecipe(sample(persona, 'recipe-scaled-start').answer);
    const scaledPage = asRecipe(sample(persona, 'recipe-scaled-page-2').answer);
    const main = client(persona, published);
    const reads = recipeReadingReads({ main, actingSubject });
    const identity = await loadRecipeIdentity(reads, recordedId(header.path));
    ready(identity);
    expect(identity.actingSubject).toBe(actingSubject);
    expect(identity.header).toEqual(header.answer as WorkHeader);
    expect(identity.href).toBe(new URL(sample(persona, 'recipe-start').path, 'https://recorded.invalid').pathname);
    expect(identity.edit).toBe(persona === 'owner');
    expect(identity.agentCredits.ok).toBe(true);
    if (identity.agentCredits.ok) {
      expect(identity.agentCredits.data).toEqual(sample(persona, 'agent-credits').answer as AgentCreditPage);
    }
    expect(identity.credits.ok).toBe(true);
    if (identity.credits.ok) {
      expect(identity.credits.data as unknown).toEqual(
        (sample(persona, 'work-credits').answer as { result: unknown }).result);
    }
    const author = identity.agentCredits.ok
      ? identity.agentCredits.data.items.find(item => item.role === 'author') : undefined;
    expect(identity.author?.name).toBe(author?.displayName);
    expect(identity.author?.handle).toBe(author?.handle ?? null);
    expect(identity.notes).toBeNull();
    expect(identity.text.ok).toBe(false);
    if (!identity.text.ok) {
      expect(identity.text.failure).toBe('missing');
      expect(identity.text.problem).toEqual(problemOf(sample(persona, 'recipe-notes-empty').answer));
    }
    const body = await loadRecipeBody(reads, identity.href);
    expect(body.kind).toBe('page');
    if (body.kind !== 'page') return;
    expect(body.page).toEqual(start);
    expect(JSON.stringify(body.page)).not.toContain('PRIVATE DRAFT');
    expect(body.page.revision).toBe(start.revision);
    expect(body.page.revision).not.toBe(draftRevision);
    const ingredient = body.page.ingredients[0];
    const amount = ingredient?.amount;
    expect(amount).toEqual({ numerator: 3, denominator: 2 });
    expect(ingredient?.line).toBe(start.ingredients[0]?.line);
    if (!amount) return;
    expect(formatQuantity(amount)).toBe('1 ½');
    expect(body.page.ingredients.some(item => item.alternateLine)).toBe(false);
    const yieldMeasure = body.page.measures.find(item => item.kind === 'yield');
    expect(yieldMeasure?.value).toEqual({ numerator: 4, denominator: 1 });
    expect(yieldMeasure?.unitText).toBe('servings');
    expect(formatMeasure(yieldMeasure!.value, yieldMeasure!.unitText)).toBe('4 servings');
    const more = await reads.readRecipe(identity.href, { cursor: body.page.next });
    expect(more.ok).toBe(true);
    if (!more.ok) return;
    expect(more.data).toEqual(continuation);
    expect(continuation.next).toBeUndefined();
    const scaledRead = await reads.readRecipe(identity.href, { servings: 8 });
    expect(scaledRead.ok).toBe(true);
    if (!scaledRead.ok || !scaledRead.data) return;
    expect(scaledRead.data).toEqual(scaled);
    expect(scaledRead.data.revision).toBe(start.revision);
    const scaledIngredient = scaledRead.data.ingredients[0];
    const scaledAmount = scaledIngredient?.amount;
    expect(scaledAmount).toEqual({ numerator: 3, denominator: 1 });
    expect(scaledIngredient?.line).toBe(scaled.ingredients[0]?.line);
    if (!scaledAmount) return;
    expect(formatQuantity(scaledAmount)).toBe('3');
    const scaledMore = await reads.readRecipe(identity.href, { cursor: scaledRead.data.next });
    expect(scaledMore.ok).toBe(true);
    if (!scaledMore.ok) return;
    expect(scaledMore.data).toEqual(scaledPage);
    const continuedAmount = scaledPage.ingredients[0]?.amount;
    expect(continuedAmount).toEqual({ numerator: 3, denominator: 1 });
    if (!continuedAmount) return;
    expect(formatQuantity(continuedAmount)).toBe('3');
  }
});

test('a continuation sends the cursor without a new serving count', async () => {
  for (const persona of personas) {
    const actingSubject = actingSubjectOf(sample(persona, 'work-header').path);
    const start = asRecipe(sample(persona, 'recipe-start').answer);
    const href = new URL(sample(persona, 'recipe-start').path, 'https://recorded.invalid').pathname;
    const main = client(persona, [{ label: 'recipe-continuation', state: 'populated' }]);
    const page = await recipePageReader({ main, actingSubject }, href)({ cursor: start.next, servings: 8 });
    expect(page.error).toBeNull();
    expect(page.data).toEqual(asRecipe(sample(persona, 'recipe-continuation').answer));
  }
});

type HeldPart = 'credits' | 'notes' | 'author' | 'reader-state' | 'showcase' | 'facts' | 'ratings' | 'stats';
function holds(part: HeldPart, path: string) {
  return part === 'credits' && path.endsWith('/agent-credits')
    || part === 'notes' && path.endsWith('/selection')
    || part === 'author' && /\/agents\/[^/]+\/works$/.test(path)
    || part === 'reader-state' && path.endsWith('/reader-state')
    || part === 'showcase' && path.endsWith('/resources/showcase')
    || part === 'facts' && path.endsWith('/statements')
    || part === 'ratings' && path.endsWith('/rating-contexts')
    || part === 'stats' && path.endsWith('/reader-stats');
}

function heldRecipeVisit(part: HeldPart, persona: AnswerPersona = 'visitor') {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const misses: unknown[] = [];
  const requests: URL[] = [];
  const visit = instructionVisitTransport(persona, 'https://recorded.invalid', source =>
    readFile(new URL(`../../../../${source}`, import.meta.url)).then(bytes => new Uint8Array(bytes)), error => misses.push(error));
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    if (holds(part, url.pathname)) {
      started.resolve();
      await gate.promise;
    }
    return visit.fetcher(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher });
  return { ...visit, gate, started, requests, misses,
    host: { ...visit.host, main, anonymous: main, publicFetch: fetcher, recordingFetch: fetcher,
      recipeReadPage: (href: string) => recipePageReader({ main, actingSubject: visit.actingSubject }, href) } };
}

test('native nutrition names and footer evidence settle while substitution author metadata is pending', async () => {
  const visit = heldRecipeVisit('credits', 'owner');
  const page = { ...nutritionPage(), structure: visit.page.structure, revision: visit.page.revision,
    instructions: visit.page.instructions };
  let summaryActor: string | undefined;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith(`/recipes/works/${visit.id}`)) return Response.json(page);
    if (url.pathname.endsWith('/resources/summaries')) {
      const body = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body));
      summaryActor = body.actingSubject;
      return Response.json({ profile: 'resource-summary-batch-v1', summaries: [...nutrientNames.values()] });
    }
    return visit.host.publicFetch(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  const host = { ...visit.host, main, publicFetch: fetcher };
  const region = await recipeRegion({ host, id: visit.id, work: visit.header,
    href: `/v1/recipes/works/${visit.id}`, locale: 'en', messages: englishMessages });
  let metadataSettled = false;
  const presentation = region.props.presentation.then((value: unknown) => { metadataSettled = true; return value; });
  try {
    await visit.started.promise;
    expect(region.props.initial.measures).toEqual(page.measures);
    expect(recipeMethodReady(region.props.initial)).toBe(true);
    expect(metadataSettled).toBe(false);
    const frame = await recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
      locale: 'en', messages: englishMessages, children: region });
    const sourceRegion = await frame.props.evidence.props.children;
    const footer = await sourceRegion.props.children[1].props.children;
    expect(footer.props.page.measures).toEqual(page.measures);
    expect([...footer.props.names.values()].map((name: { name?: { value: string } }) => name.name?.value))
      .toEqual(['Energy', 'Protein', 'Fibre']);
    expect(summaryActor).toBe(visit.actingSubject ?? undefined);
    expect(metadataSettled).toBe(false);
  } finally {
    visit.gate.resolve();
    const metadata = await presentation;
    expect(metadata.authors).toEqual(['Outcome owner']);
    visit.dispose();
  }
  expect(visit.misses).toEqual([]);
});

test.each(['credits', 'notes', 'author'] as const)(
  'the selected Recipe method and Cook settle while unrelated %s remain pending', async part => {
    const visit = heldRecipeVisit(part);
    let returned = false;
    const pending = recipeWorkOverview({ host: visit.host, id: visit.id, workRef: visit.id, work: visit.header,
      scope: EVERYONE, locale: 'en', messages: englishMessages }).then(node => { returned = true; return node; });
    try {
      await visit.started.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(returned).toBe(true);
      const overview = await pending;
      const region = await overview.props.type.props.children[1].props.children;
      expect(region.props.initial).toMatchObject({ structure: visit.page.structure, revision: visit.page.revision });
      expect(region.props.initial.instructions.map((item: { occurrence: string }) => item.occurrence))
        .toEqual(visit.page.instructions?.map(item => item.occurrence));
      expect(region.props.resource).toBe(visit.header.id);
      expect(recipeMethodReady(region.props.initial)).toBe(true);
      // A real sibling refusal remains a refusal; recovering the method cannot turn it into an empty list.
      const parts = await overview.props.parts.props.children;
      expect(parts.props.children[1].props.parts).toMatchObject({ ok: false, failure: 'missing', status: 404 });
      const frame = await recipeWorkFrame({ host: visit.host, id: visit.id, workRef: visit.id, work: visit.header,
        locale: 'en', messages: englishMessages, children: overview });
      expect(frame.props.work).toBe(visit.header);
      const action = await frame.props.readAction.props.children;
      expect(action.props.kind).toBe('recipe');
      expect(action.props.workId).toBe(visit.header.id);
      expect(action.props.workRef).toBe(visit.id);
      expect(action.props.canCook).toBe(true);
      expect(action.props.recipeHref).toBe(region.props.href);
      const methodRequests = visit.requests.filter(url => url.pathname.endsWith(`/recipes/works/${visit.id}`));
      expect(methodRequests.length).toBeGreaterThan(0);
      expect(methodRequests.every(url => url.searchParams.get('actingSubject') === null)).toBe(true);
    } finally {
      visit.gate.resolve();
      await pending;
      // Drain the supplemental identity read so no pending replay outlives its transport.
      await loadRecipeIdentity(recipeReadingReads({ main: visit.host.main }), visit.id);
      visit.dispose();
    }
    expect(visit.misses).toEqual([]);
  },
);

test('recovering the method retains the signed-in Work and its captured shelf seed', async () => {
  const visit = heldRecipeVisit('credits', 'owner');
  let failing = true;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (failing && url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
      return Response.json({ code: 'specific_unavailable' }, { status: 503 });
    }
    return visit.host.publicFetch(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  const host = { ...visit.host, main };
  const read = () => recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
    locale: 'en', messages: englishMessages, children: null });
  try {
    const failed = await read();
    expect((await failed.props.readAction.props.children).props.canCook).toBe(false);
    const failedShelf = await failed.props.shelfAction.props.children;
    const failedRating = await failed.props.ratingAction.props.children;
    expect(failedShelf.props.seed).toBeDefined();
    expect(failed.props.actingSubject).toBe(visit.actingSubject);
    failing = false;
    const recovered = await read();
    expect(recovered.props.work).toBe(visit.header);
    expect(recovered.props.actingSubject).toBe(failed.props.actingSubject);
    const recoveredShelf = await recovered.props.shelfAction.props.children;
    const recoveredRating = await recovered.props.ratingAction.props.children;
    expect(recoveredShelf.props.seed).toEqual(failedShelf.props.seed);
    expect(recoveredShelf.props.actingSubject).toBe(visit.actingSubject);
    expect(recoveredRating.props.ratingTarget).toEqual(failedRating.props.ratingTarget);
    expect((await recovered.props.readAction.props.children).props.kind).toBe('recipe');
  } finally {
    visit.gate.resolve();
    await loadRecipeIdentity(recipeReadingReads({ main, actingSubject: visit.actingSubject }), visit.id);
    visit.dispose();
  }
  expect(visit.misses).toEqual([]);
});

test('a recovered method does not wait for its notes or hide a notes failure', async () => {
  const visit = heldRecipeVisit('notes');
  let failing = true;
  let attempts = 0;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
      attempts++;
      if (failing) return Response.json({ code: 'specific_unavailable' }, { status: 503 });
    }
    if (url.pathname.endsWith('/selection')) {
      visit.started.resolve();
      await visit.gate.promise;
      return Response.json({ code: 'work_read_unavailable' }, { status: 503 });
    }
    return visit.fetcher(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const host = { ...visit.host, main, recipeReadPage: undefined, recordingFetch: undefined };
  const read = () => recipeRegion({ host, id: visit.id, work: visit.header, href: `/v1/recipes/works/${visit.id}`,
    locale: 'en', messages: englishMessages });
  try {
    const failed = await read();
    expect(failed.props.failure).toBe('unavailable');
    expect(failed.props.initial).toBeNull();
    expect(attempts).toBe(1);
    failing = false;
    const recovered = await read();
    expect(recovered.props.failure).toBeUndefined();
    expect(recovered.props.initial.revision).toBe(visit.page.revision);
    expect(recipeMethodReady(recovered.props.initial)).toBe(true);
    expect(attempts).toBe(2);
    visit.gate.resolve();
    const notes = await recovered.props.notes;
    expect(notes.props).toMatchObject({ title: englishMessages.recipeNotes, failure: 'unavailable' });
    await failed.props.notes;
  } finally {
    visit.gate.resolve();
    visit.dispose();
  }
  expect(visit.misses).toEqual([]);
});

test('Cook requires a complete published method, including every available instruction', async () => {
  // An available selection has not yet disclosed its method text or recording.
  expect(recipeMethodReady(instructionVisitIdentity('visitor').page)).toBe(false);
  const visit = heldRecipeVisit('credits');
  try {
    const answer = await recipeReadingReads({ main: visit.host.main }).readRecipe(`/v1/recipes/works/${visit.id}`);
    expect(answer.ok).toBe(true);
    if (!answer.ok || !answer.data) throw new Error('Captured Recipe method was not read');
    const instructions = answer.data;
    expect(recipeMethodReady(instructions)).toBe(true);
    expect(recipeMethodReady(null)).toBe(false);
    expect(recipeMethodReady({ ...instructions, next: 'next-page' })).toBe(false);
    expect(recipeMethodReady({ ...instructions, instructions: instructions.instructions?.map((item, index) =>
      index === 0 ? { ...item, status: 'unavailable' } : item) })).toBe(false);
    expect(recipeMethodReady({ ...instructions, instructions: [], occurrences: [] })).toBe(false);
    const first = asRecipe(sample('visitor', 'recipe-start').answer);
    const last = asRecipe(sample('visitor', 'recipe-continuation').answer);
    expect(recipeMethodReady(first)).toBe(false);
    expect(recipeMethodReady(appendRecipePage(first, last))).toBe(true);
  } finally {
    visit.gate.resolve();
    visit.dispose();
  }
  expect(visit.misses).toEqual([]);
});

test.each(['browser', 'server'] as const)('Recipe recovery respects the %s transport attempt bound', async transport => {
  const start = sample('owner', 'recipe-start');
  const actingSubject = actingSubjectOf(start.path);
  const requests: URL[] = [];
  let failing = true;
  const sender = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)));
    if (failing) throw Object.assign(new TypeError('Connection closed'), { code: 'ECONNRESET' });
    return Response.json(start.answer);
  }, { preconnect: fetch.preconnect });
  const main = transport === 'browser' ? browserMainApi('https://recorded.invalid', { fetcher: sender })
    : mainApiWithToken(undefined, { fetcher: Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => serverFetch(input, init, { fetch: sender }),
      { preconnect: fetch.preconnect },
    ) });
  const read = recipePageReader({ main, actingSubject }, start.path);
  const failed = await read({ cursor: 'exact-retry-cursor', servings: 8 });
  expect(failed.data).toBeNull();
  expect(failed.error?.status).toBe(503);
  // The client already repeated the failed socket. The Recipe owner must not multiply its attempts.
  expect(requests).toHaveLength(2);
  expect(requests[1]!.href).toBe(requests[0]!.href);
  expect(requests[0]!.searchParams.get('actingSubject')).toBe(actingSubject);
  expect(requests[0]!.searchParams.get('cursor')).toBe('exact-retry-cursor');
  expect(requests[0]!.searchParams.has('servings')).toBe(false);
  failing = false;
  const recovered = await read({ cursor: 'exact-retry-cursor', servings: 8 });
  expect(requests).toHaveLength(3);
  expect(requests[2]!.href).toBe(requests[0]!.href);
  expect(recovered.error).toBeNull();
  expect(recovered.data).toEqual(asRecipe(start.answer));
});

test('a cancelled owner followed by a lost connection uses at most three native attempts', async () => {
  let attempts = 0;
  const sender = async () => {
    if (++attempts === 1) return Response.json({ code: 'work_read_unavailable' }, { status: 503 });
    throw Object.assign(new TypeError('Connection closed'), { code: 'ECONNRESET' });
  };
  const main = mainApiWithToken(undefined, { fetcher: Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => serverFetch(input, init, { fetch: sender }),
    { preconnect: fetch.preconnect },
  ) });
  const answer = await recipePageReader({ main }, '/v1/recipes/works/00000000-0000-4000-8000-000000000001')({});
  expect(answer.error?.status).toBe(503);
  expect(answer.data).toBeNull();
  expect(attempts).toBe(3);
});

test.each(['AbortError', 'TimeoutError'])('a Recipe %s stays failed without restarting its exhausted read', async name => {
  let attempts = 0;
  const main = mainApiWithToken(undefined, { fetcher: Object.assign(async () => {
    attempts++;
    throw new DOMException('Read stopped', name);
  }, { preconnect: fetch.preconnect }) });
  const answer = await recipePageReader({ main }, '/v1/recipes/works/00000000-0000-4000-8000-000000000001')({});
  expect(answer.error?.status).toBe(503);
  expect(answer.data).toBeNull();
  expect(attempts).toBe(1);
});

test.each(['reader-state', 'showcase', 'facts', 'ratings', 'stats'] as const)(
  'the production frame recovers its exact method and Cook while %s is still pending', async part => {
    const visit = heldRecipeVisit(part, 'owner');
    let failing = true;
    let failedNativeReads = 0;
    const methodRequests: URL[] = [];
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
        methodRequests.push(url);
        if (failing) {
          failedNativeReads++;
          return Response.json({ code: 'specific_unavailable' }, { status: 503 });
        }
      }
      return visit.host.publicFetch(input, init);
    }, { preconnect: fetch.preconnect });
    const main = browserMainApi('https://recorded.invalid', { fetcher });
    const host = { ...visit.host, main, publicFetch: fetcher,
      recipeReadPage: (href: string) => recipePageReader({ main, actingSubject: visit.actingSubject }, href) };
    const read = () => recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
      locale: 'en', messages: englishMessages, children: recipeRegion({ host, id: visit.id,
        work: visit.header, href: `/v1/recipes/works/${visit.id}`, locale: 'en', messages: englishMessages }) });
    let returned = false;
    const frameRead = read().then(frame => { returned = true; return frame; });
    let recoveredRead: ReturnType<typeof read> | undefined;
    try {
      await visit.started.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(returned).toBe(true);
      const failedFrame = await frameRead;
      const failedMethod = await failedFrame.props.children;
      expect(failedMethod.props).toMatchObject({ resource: visit.header.id, failure: 'unavailable', initial: null });
      expect((await failedFrame.props.readAction.props.children).props.canCook).toBe(false);
      failing = false;
      let recoveredReturned = false;
      recoveredRead = read().then(frame => { recoveredReturned = true; return frame; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(recoveredReturned).toBe(true);
      const frame = await recoveredRead;
      expect(frame.props.work).toBe(visit.header);
      const method = await frame.props.children;
      expect(method.props.resource).toBe(visit.header.id);
      expect(method.props.actingSubject).toBe(visit.actingSubject);
      expect(method.props.href).toBe(failedMethod.props.href);
      expect(method.props.initial.revision).toBe(visit.page.revision);
      expect(method.props.initial.structure).toBe(visit.page.structure);
      expect(method.props.initial.instructions.map((item: { occurrence: string }) => item.occurrence))
        .toEqual(visit.page.instructions?.map(item => item.occurrence));
      expect(recipeMethodReady(method.props.initial)).toBe(true);
      const action = await frame.props.readAction.props.children;
      expect(action.props).toMatchObject({ workId: visit.header.id, recipeHref: method.props.href, canCook: true });
      expect(failedNativeReads).toBe(2); // No RSC request cache in this owner test: region and frame each read once.
      expect(new Set(methodRequests.map(url => url.href)).size).toBe(1);
      expect(methodRequests.every(url => url.searchParams.get('actingSubject') === visit.actingSubject)).toBe(true);
      // A private pending answer cannot initialize the catalogue store as known unsaved.
      let shelfSettled = false;
      void frame.props.shelfAction.props.children.then(() => { shelfSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(shelfSettled).toBe(part !== 'reader-state');
      if (part !== 'reader-state') {
        const shelf = await frame.props.shelfAction.props.children;
        const initialShelf = await failedFrame.props.shelfAction.props.children;
        expect(shelf.props.seed).toEqual(initialShelf.props.seed);
        expect(shelf.props.seed[visit.header.id]).toMatchObject({ status: null, version: 0 });
      }
    } finally {
      visit.gate.resolve();
      for (const pending of [frameRead, recoveredRead]) {
        if (!pending) continue;
        const frame = await pending;
        await Promise.all([frame.props.shelfAction.props.children, frame.props.ratingAction.props.children,
          frame.props.evidence.props.children, frame.props.identity.props.children.props.children]);
      }
      visit.dispose();
    }
    expect(visit.misses).toEqual([]);
  },
);

test('method recovery preserves refused frame auxiliaries and never invents saved status', async () => {
  const visit = heldRecipeVisit('credits', 'owner');
  let failing = true;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (failing && url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
      return Response.json({ code: 'specific_unavailable' }, { status: 503 });
    }
    if ((['reader-state', 'showcase', 'facts', 'ratings'] as const).some(part => holds(part, url.pathname))) {
      return Response.json({ code: 'specific_unavailable' }, { status: 503 });
    }
    return visit.host.publicFetch(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  const host = { ...visit.host, main, publicFetch: fetcher };
  const read = () => recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
    locale: 'en', messages: englishMessages, children: recipeRegion({ host, id: visit.id,
      work: visit.header, href: `/v1/recipes/works/${visit.id}`, locale: 'en', messages: englishMessages }) });
  try {
    const failed = await read();
    expect((await failed.props.children).props.failure).toBe('unavailable');
    expect((await failed.props.readAction.props.children).props.canCook).toBe(false);
    const failedShelf = await failed.props.shelfAction.props.children;
    expect(failedShelf.props).toMatchObject({ title: englishMessages.savedStatus, failure: 'unavailable' });
    failing = false;
    const frame = await read();
    const method = await frame.props.children;
    expect(method.props.resource).toBe(visit.header.id);
    expect(method.props.initial.revision).toBe(visit.page.revision);
    expect(recipeMethodReady(method.props.initial)).toBe(true);
    expect((await frame.props.readAction.props.children).props.canCook).toBe(true);
    const shelf = await frame.props.shelfAction.props.children;
    expect(shelf.props).toMatchObject({ title: englishMessages.savedStatus, failure: 'unavailable' });
    expect(shelf.props.seed).toBeUndefined();
    expect((await frame.props.ratingAction.props.children).props)
      .toMatchObject({ title: englishMessages.ratings, failure: 'unavailable' });
    const identity = await frame.props.identity.props.children.props.children;
    expect(identity.props.children[1].props).toMatchObject({ title: englishMessages.artwork, failure: 'unavailable' });
    const evidence = await frame.props.evidence.props.children;
    expect(evidence.props.statements).toMatchObject({ ok: false, failure: 'unavailable', status: 503 });
    const header = identity.props.children[0];
    const ratingLine = await header.props.ratingLine.props.children;
    expect(ratingLine.props.ratings).toMatchObject({ ok: false, failure: 'unavailable' });
  } finally {
    visit.gate.resolve();
    visit.dispose();
  }
  expect(visit.misses).toEqual([]);
});
