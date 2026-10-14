import { afterEach, expect, test } from 'bun:test';
import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import authoringFixture from '../../../../tests/qa/fixtures/outcomes/recipes/author-a-recipe.json';
import exchangeFixture from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { clearTypes } from '../catalogue/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { readRecipe, writePlan } from './api.ts';
import type { Operation } from './intents.ts';
import { mainRecipeExportApi } from './export-api.ts';
import { readingLine } from './ingredient-line.ts';
import { mainRecipeImportApi } from './import-api.ts';
import { ingredients, steps } from './model.ts';
import {
  loadRecipeAuthoring,
  readRecipeVisitFrame,
  recordedFileImportTarget,
  type RecipeAuthoringMapped,
} from './recipe-authoring-recorded-page.ts';

const authoring = authoringFixture as AnswerRecord;
const exchange = exchangeFixture as AnswerRecord;
const origin = 'https://recorded.invalid';
const disposals: (() => void)[] = [];

afterEach(() => {
  clearTypes();
  for (const dispose of disposals.splice(0)) dispose();
});

function sample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find((item) => item.label === label);
  if (!found) throw new Error(`Missing ${record.row}/${persona}/${label}`);
  return found;
}

function replay(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
) {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const main = browserMainApi(origin, {
    anonymous: persona === 'visitor',
    fetcher: transport.fetcher,
  });
  return { main, fetcher: transport.fetcher };
}

function actingSubject(record: AnswerRecord, persona: AnswerPersona, label: string): string {
  const value = new URL(sample(record, persona, label).path, origin).searchParams.get(
    'actingSubject',
  );
  if (!value) throw new Error(`No acting subject on ${label}`);
  return value;
}

function workId(record: AnswerRecord, persona: AnswerPersona): string {
  return new URL(sample(record, persona, 'editor-work-header').path, origin).pathname
    .split('/')
    .pop()!;
}

const authorReads = [
  { label: 'editor-authority', state: 'populated' },
  { label: 'editor-work-header', state: 'populated' },
  { label: 'editor-resource-summary', state: 'populated' },
  { label: 'editor-metadata-empty', state: 'populated' },
  { label: 'editor-recipe-draft', state: 'populated' },
  { label: 'editor-notes-empty', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const exchangeReads = [
  { label: 'editor-authority', state: 'populated' },
  { label: 'editor-work-header', state: 'populated' },
  { label: 'editor-resource-summary', state: 'populated' },
  { label: 'editor-metadata-empty', state: 'populated' },
  { label: 'editor-recipe', state: 'populated' },
  { label: 'editor-notes-empty', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const visitFrame = [
  { label: 'frame-platform-access', state: 'populated' },
  { label: 'frame-types', state: 'populated' },
  { label: 'frame-official-zones', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const signedInFrame = [
  ...visitFrame,
  { label: 'frame-acting-contexts', state: 'populated' },
  { label: 'frame-agent-choices', state: 'populated' },
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'frame-agent-profile', state: 'populated' },
  { label: 'frame-person-preferences', state: 'populated' },
  { label: 'frame-managed-realms', state: 'populated' },
  { label: 'frame-pinned-communities', state: 'populated' },
  { label: 'frame-space-communities', state: 'populated' },
  { label: 'frame-follow-inventory', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

function editorOf(view: RecipeAuthoringMapped) {
  if (view.kind !== 'editor')
    throw new Error(
      `expected the editor, received ${view.kind}${view.kind === 'discrepancy' ? `: ${view.detail}` : ''}`,
    );
  return view;
}

test('an owner opens the recorded draft at its head', async () => {
  const { main } = replay(authoring, 'owner', authorReads);
  const actor = actingSubject(authoring, 'owner', 'editor-work-header');
  const id = workId(authoring, 'owner');
  const draft = sample(authoring, 'owner', 'editor-recipe-draft');
  const summary = sample(authoring, 'owner', 'editor-resource-summary');
  const answer = draft.answer as {
    structure: string;
    revision: string;
    next?: string | null;
    occurrences: {
      role: string;
      state: string;
      qualifier?: {
        instructionText?: { value: string };
        amount?: { numerator: number; denominator: number };
        originalText?: { value: string };
        unitText?: string;
      };
    }[];
  };
  const loaded = await readRecipe(main, id, actor);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const title = (summary.answer as { name: { value: string } }).name.value;
  const named = await main.v1.resources({ resource: id }).get({ query: { actingSubject: actor } });
  expect(named.error).toBeNull();
  expect((named.data as { name?: { value?: string } } | null)?.name?.value).toBe(title);
  expect(loaded.data.structure).toBe(answer.structure);
  expect(loaded.data.head).toBe(answer.revision);
  expect(answer.next ?? null).toBeNull();
  const stepValues = answer.occurrences
    .filter((item) => item.role === 'step' && item.state === 'active')
    .map((item) => item.qualifier?.instructionText?.value ?? '');
  expect(steps(loaded.data).map((node) => node.qualifier.instructionText.value)).toEqual(
    stepValues,
  );
  expect(stepValues).toContain('Private draft note.');
  const amounts = answer.occurrences
    .filter((item) => item.role === 'ingredient' && item.state === 'active')
    .map((item) => item.qualifier?.amount ?? null);
  expect(ingredients(loaded.data).map((node) => node.qualifier.amount ?? null)).toEqual(amounts);
  const lines = answer.occurrences
    .filter((item) => item.role === 'ingredient' && item.state === 'active' && item.qualifier)
    .map((item) => readingLine(item.qualifier as never));
  expect(ingredients(loaded.data).map((node) => readingLine(node.qualifier))).toEqual(lines);
  expect(lines).toEqual(['1 ½ cup flour', '¼ cup flour']);
  const notes = await main.v1.me.contributions.get({ query: { actingSubject: actor, limit: 20 } });
  expect(notes.error).toBeNull();
  expect(notes.data?.items).toEqual([]);
  expect(notes.data?.nextCursor ?? null).toBeNull();
});

test('a visitor is asked to sign in and the authority read is not sent', async () => {
  const { main } = replay(authoring, 'visitor', [
    { label: 'editor-work-header', state: 'populated' },
  ]);
  const view = await loadRecipeAuthoring(main, {
    id: workId(authoring, 'visitor'),
    actingSubject: null,
    signedIn: false,
  });
  expect(view).toEqual({ kind: 'no-authority', signedIn: false });
});

test('a stranger without edit authority does not reach the draft', async () => {
  const { main } = replay(authoring, 'stranger', [
    { label: 'editor-authority', state: 'populated' },
    { label: 'editor-work-header', state: 'populated' },
  ]);
  const view = await loadRecipeAuthoring(main, {
    id: workId(authoring, 'stranger'),
    actingSubject: actingSubject(authoring, 'stranger', 'editor-authority'),
    signedIn: true,
  });
  expect(view).toEqual({ kind: 'no-authority', signedIn: true });
});

test('the owner saves the recorded private draft against its head', async () => {
  const saved = sample(authoring, 'owner', 'new-private-draft');
  const body = saved.body as {
    expectedHead: string;
    actingSubject: string;
    operations: Operation[];
  };
  const { main } = replay(authoring, 'owner', [{ label: 'new-private-draft', state: 'populated' }]);
  const id = saved.path.match(/\/v1\/compositions\/([^/]+)\/changes/)?.[1];
  const written = await writePlan(main, {
    structure: `https://rezics.com/id/${id}`,
    head: body.expectedHead,
    actingSubject: body.actingSubject,
    plan: { kind: 'changes', operations: body.operations },
    key: 'recorded-private-draft',
  });
  expect(written.ok).toBe(true);
  if (written.ok)
    expect(written.data.revision).toBe((saved.answer as { revision: string }).revision);
});

test('a stranger edit keeps the recorded refusal', async () => {
  const refused = sample(authoring, 'stranger', 'peer-edit-denied');
  const body = refused.body as {
    expectedHead: string;
    actingSubject: string;
    operations: Operation[];
  };
  const problem = refused.answer as { title: string; code: string };
  const { main } = replay(authoring, 'stranger', [{ label: 'peer-edit-denied', state: 'error' }]);
  const id = refused.path.match(/\/v1\/compositions\/([^/]+)\/changes/)?.[1];
  const written = await writePlan(main, {
    structure: `https://rezics.com/id/${id}`,
    head: body.expectedHead,
    actingSubject: body.actingSubject,
    plan: { kind: 'changes', operations: body.operations },
    key: 'recorded-peer-edit',
  });
  expect(written).toMatchObject({
    ok: false,
    status: refused.status,
    problem: 'denied',
    detail: problem.title,
  });
  expect(problem.code).toBe('authority_denied');
});

test('a visitor edit keeps the recorded account refusal', async () => {
  const refused = sample(authoring, 'visitor', 'peer-edit-denied');
  const body = refused.body as {
    expectedHead: string;
    actingSubject: string;
    operations: Operation[];
  };
  const problem = refused.answer as { title: string };
  const { main } = replay(authoring, 'visitor', [{ label: 'peer-edit-denied', state: 'error' }]);
  const id = refused.path.match(/\/v1\/compositions\/([^/]+)\/changes/)?.[1];
  const written = await writePlan(main, {
    structure: `https://rezics.com/id/${id}`,
    head: body.expectedHead,
    actingSubject: body.actingSubject,
    plan: { kind: 'changes', operations: body.operations },
    key: 'recorded-visitor-edit',
  });
  expect(written).toMatchObject({
    ok: false,
    status: refused.status,
    problem: 'sign-in',
    detail: problem.title,
  });
});

test('the recorded draft and the empty imported composition are read as themselves', async () => {
  const draft = sample(authoring, 'owner', 'editor-recipe-draft');
  const draftAnswer = draft.answer as {
    structure: string;
    revision: string;
    occurrences: unknown[];
  };
  const draftClient = replay(authoring, 'owner', [
    { label: 'editor-recipe-draft', state: 'populated' },
  ]);
  const loaded = await readRecipe(
    draftClient.main,
    workId(authoring, 'owner'),
    actingSubject(authoring, 'owner', 'editor-recipe-draft'),
  );
  expect(loaded.ok).toBe(true);
  if (loaded.ok) {
    expect(loaded.data.structure).toBe(draftAnswer.structure);
    expect(loaded.data.head).toBe(draftAnswer.revision);
    expect(loaded.data.nodes).toHaveLength(draftAnswer.occurrences.length);
  }

  const empty = sample(exchange, 'owner', 'recipe-empty');
  const emptyAnswer = empty.answer as {
    structure: string;
    revision: string;
    occurrences: unknown[];
  };
  const emptyClient = replay(exchange, 'owner', [{ label: 'recipe-empty', state: 'empty' }]);
  const work = new URL(empty.path, origin).pathname.split('/').pop()!;
  const cleared = await readRecipe(
    emptyClient.main,
    work,
    actingSubject(exchange, 'owner', 'recipe-empty'),
  );
  expect(cleared.ok).toBe(true);
  if (cleared.ok) {
    expect(cleared.data.nodes).toEqual([]);
    expect(cleared.data.structure).toBe(emptyAnswer.structure);
    expect(cleared.data.head).toBe(emptyAnswer.revision);
  }
  expect(emptyAnswer.occurrences).toEqual([]);
});

test('the owner exports the recorded revision and the work keeps its author credit', async () => {
  const exported = sample(exchange, 'owner', 'schema-org-export');
  const credits = sample(exchange, 'owner', 'public-credits');
  const { main } = replay(exchange, 'owner', [
    { label: 'schema-org-export', state: 'populated' },
    { label: 'public-credits', state: 'populated' },
  ]);
  const url = new URL(exported.path, origin);
  const structure = `https://rezics.com/id/${url.pathname.split('/')[3]}`;
  const revision = url.searchParams.get('revision')!;
  const actor = url.searchParams.get('actingSubject')!;
  const file = await mainRecipeExportApi(() => main).exportRevision({
    structure,
    revision,
    actingSubject: actor,
  });
  const answer = exported.answer as {
    revision: string;
    structure: string;
    recipe: Record<string, unknown>;
  };
  expect(file.revision).toBe(answer.revision);
  expect(file.structure).toBe(answer.structure);
  expect(file.recipe).toEqual(answer.recipe);

  const creditUrl = new URL(credits.path, origin);
  const read = await main.v1
    .works({ id: creditUrl.pathname.split('/')[3]! })
    .credits.get({ query: { actingSubject: actor } });
  expect(read.error).toBeNull();
  const items = (
    credits.answer as {
      items: { role: string; agent: string; displayName: string | null; handle: string | null }[];
    }
  ).items;
  expect(JSON.parse(JSON.stringify(read.data?.items))).toEqual(
    (credits.answer as { items: unknown[] }).items,
  );
  expect(items.find((item) => item.role === 'author')).toMatchObject({
    agent: actor,
    displayName: null,
    handle: null,
  });
});

test('a recorded file import keeps its revision and a stale head keeps the refusal', async () => {
  const imported = sample(exchange, 'owner', 'file-import');
  const importedAnswer = imported.answer as {
    revision: string;
    sourceObservation: string;
    replayed: boolean;
  };
  const target = recordedFileImportTarget(imported.path)!;
  const file = new File([JSON.stringify(imported.body)], 'recipe.json', {
    type: 'application/json',
  });
  const { fetcher } = replay(exchange, 'owner', [{ label: 'file-import', state: 'populated' }]);
  const result = await mainRecipeImportApi({ fetch: fetcher, origin }).importFile({
    ...target,
    idempotencyKey: 'recipe-file-import:recorded',
    file,
  });
  expect(result.revision).toBe(importedAnswer.revision);
  expect(result.sourceObservation).toBe(importedAnswer.sourceObservation);
  expect(result.replayed).toBe(importedAnswer.replayed);

  const stale = sample(exchange, 'owner', 'file-import-stale');
  const staleAnswer = stale.answer as { title: string; code: string };
  const staleTarget = recordedFileImportTarget(stale.path)!;
  const staleFile = new File([JSON.stringify(stale.body)], 'recipe.json', {
    type: 'application/json',
  });
  const staleReplay = replay(exchange, 'owner', [{ label: 'file-import-stale', state: 'error' }]);
  const refusal = await mainRecipeImportApi({ fetch: staleReplay.fetcher, origin })
    .importFile({
      ...staleTarget,
      idempotencyKey: 'recipe-file-import:stale',
      file: staleFile,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(refusal).toMatchObject({ failure: 'stale', detail: staleAnswer.title });
  expect(staleAnswer.code).toBe('recipe_conflict');
});

test('publishing the imported recipe does not grant original-contribution rights', async () => {
  const refused = sample(exchange, 'owner', 'publication-denied');
  const problem = refused.answer as { title: string; code: string };
  const body = refused.body as { rightsBasis: string };
  const { main } = replay(exchange, 'owner', [{ label: 'publication-denied', state: 'error' }]);
  const posted = await main.v1['work-publications'].post(refused.body as never);
  expect(refused.status).toBe(403);
  expect(posted.error?.status).toBe(403);
  expect(posted.error?.value).toMatchObject({ title: problem.title, code: problem.code });
  expect(body.rightsBasis).toBe('original-contribution');
  expect(problem.code).toBe('authority_denied');
});

test('the exchange visit frame opens the owner editor and refuses everyone else', async () => {
  const owner = replay(exchange, 'owner', [...signedInFrame, ...exchangeReads]);
  const framed = await readRecipeVisitFrame(owner.main, owner.fetcher, {
    actingSubject: actingSubject(exchange, 'owner', 'editor-work-header'),
    locale: 'en',
    origin,
  });
  expect(framed.ok).toBe(true);
  const view = editorOf(
    await loadRecipeAuthoring(owner.main, {
      id: workId(exchange, 'owner'),
      actingSubject: actingSubject(exchange, 'owner', 'editor-work-header'),
      signedIn: true,
    }),
  );
  const recipe = sample(exchange, 'owner', 'editor-recipe').answer as {
    structure: string;
    revision: string;
  };
  expect(view.initial.recipe.structure).toBe(recipe.structure);
  expect(view.initial.recipe.head).toBe(recipe.revision);
  expect(view.initial.next).toBe(
    (sample(exchange, 'owner', 'editor-recipe').answer as { next?: string | null }).next ?? null,
  );
  expect(view.initial.notes).toEqual({ text: null, head: null, body: '', publicationHead: null });
  const exchangeTitle = (
    sample(exchange, 'owner', 'editor-resource-summary').answer as { name: { value: string } }
  ).name.value;
  expect(view.initial.details.values.entries.some((entry) => entry.title === exchangeTitle)).toBe(
    true,
  );

  const visitor = replay(exchange, 'visitor', [
    ...visitFrame,
    { label: 'editor-work-header', state: 'populated' },
  ]);
  await readRecipeVisitFrame(visitor.main, visitor.fetcher, {
    actingSubject: null,
    locale: 'en',
    origin,
  });
  expect(
    await loadRecipeAuthoring(visitor.main, {
      id: workId(exchange, 'visitor'),
      actingSubject: null,
      signedIn: false,
    }),
  ).toEqual({ kind: 'no-authority', signedIn: false });

  for (const persona of ['stranger', 'member', 'moderator', 'operator'] as const) {
    const person = replay(exchange, persona, [
      ...signedInFrame,
      { label: 'editor-authority', state: 'populated' },
      { label: 'editor-work-header', state: 'populated' },
    ]);
    await readRecipeVisitFrame(person.main, person.fetcher, {
      actingSubject: actingSubject(exchange, persona, 'editor-authority'),
      locale: 'en',
      origin,
    });
    expect(
      await loadRecipeAuthoring(person.main, {
        id: workId(exchange, persona),
        actingSubject: actingSubject(exchange, persona, 'editor-authority'),
        signedIn: true,
      }),
    ).toEqual({ kind: 'no-authority', signedIn: true });
  }
});

test('the empty and imported recipe answers share one path', () => {
  const empty = sample(exchange, 'owner', 'recipe-empty');
  expect(sample(exchange, 'owner', 'imported-recipe').path).toBe(empty.path);
  expect((empty.answer as { occurrences: unknown[] }).occurrences).toEqual([]);
});
