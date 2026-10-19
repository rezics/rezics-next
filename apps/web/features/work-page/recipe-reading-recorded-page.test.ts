import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import recipes from '../../../../tests/qa/fixtures/outcomes/recipes/read-a-recipe.json';
import { mainApiWithToken } from '../api/main.ts';
import { formatMeasure, formatQuantity } from '../recipe-editor/quantity.ts';
import { recipeMethodReady, type Instruction } from '../recipe-editor/instructions.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import type { RecordedProblem } from './books-language-recorded-page.ts';
import {
  loadRecipeBody,
  loadRecipeIdentity,
  recipePageReader,
  recipeReadingReads,
  type RecipeIdentity,
} from './recipe-reading-recorded-page.ts';
import type { AgentCreditPage, RecipeWorkPage, WorkHeader } from './types.ts';

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
