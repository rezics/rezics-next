import type { DetailsValues } from '../studio/details-form.tsx';
import type { MainClient } from '../studio/types.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { applyOperations, type Operation } from './intents.ts';
import type { Measure, Node, RecipeState, StepQualifier } from './model.ts';
import type { NotesState } from './saves.ts';

// Stand-ins for Main in stories and tests: a recipe that answers like Main does, with the head
// every write expects and a 409 when it moved, so the editor's own handling is what is exercised.

export const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const work = id(5);
export const mainVersion = id(6);
export const actingSubject = id(7);
export const structure = id(8);

const line = (text: string) => qualifierOf(parseLine(text), 'en');
const step = (text: string, usesIngredient: string[] = []): StepQualifier =>
  ({ type: 'recipe-step', instructionText: { value: text, language: 'en' }, usesIngredient, media: [], scaling: 'linear' });

/** A recipe with a duplicate ingredient name in two sections and a step that uses the first. */
export const sampleNodes: Node[] = [
  { occurrence: id(11), parent: structure, role: 'group', label: { value: 'Cake', language: 'en' } },
  { occurrence: id(12), parent: structure, role: 'group', label: { value: 'Icing', language: 'en' } },
  { occurrence: id(13), parent: structure, role: 'step', qualifier: step('Cream the butter with the sugar.', [id(21)]) },
  { occurrence: id(21), parent: id(11), role: 'ingredient', qualifier: line('200 g butter, softened') },
  { occurrence: id(22), parent: id(11), role: 'ingredient', qualifier: line('1½ cups flour, sifted') },
  { occurrence: id(23), parent: id(12), role: 'ingredient', qualifier: line('100 g butter') },
];

const minutes = (kind: Measure['kind'], value: number): Measure => ({ kind, value: { numerator: value, denominator: 1 }, unitText: 'min',
  basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' });
export const sampleMeasures: Measure[] = [
  { kind: 'yield', value: { numerator: 12, denominator: 1 }, unitText: 'muffins', basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' },
  { kind: 'servings', value: { numerator: 6, denominator: 1 }, unitText: 'servings', basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' },
  minutes('preparation-duration', 20),
];

export const startRecipe: RecipeState = { structure, head: id(900), nodes: sampleNodes, measures: sampleMeasures };
export const emptyStart: RecipeState = { structure: null, head: null, nodes: [], measures: [] };

export const detailsValues: DetailsValues = { originalTitle: '', originalLanguage: '', completion: '',
  entries: [{ language: 'en', title: 'Lemon muffins', description: 'Bright and tender.', tagline: '', label: null }] };
export const noNotes: NotesState = { text: null, head: null, body: '', publicationHead: null };

export interface Call { name: string; body?: unknown; key?: string }

/** Fixed order of the stand-in's revision numbers, so a story's heads are the same every run. */
export function fakeMain(start: { recipe: RecipeState; notes?: NotesState; details?: DetailsValues; metadataHead?: string }) {
  let recipe = start.recipe;
  let revisions = 1000;
  const next = () => id(revisions++);
  let metadata = { head: start.metadataHead ?? id(700), values: start.details ?? detailsValues };
  let notes = { ...(start.notes ?? noNotes), text: start.notes?.text ?? null };
  const calls: Call[] = [];
  const interference: { before?: (call: Call) => void;
    /** Holds every call until it settles, to put several edits in flight together. */ gate?: Promise<void>;
    /** Holds the calls of one name (`changes`, `timings`, `details`, `notes-create`, `publish`…); the call is recorded first. */
    gates?: Record<string, Promise<void>>;
    /** Successive calls of one name each wait for the promise at that index; later calls wait for the last. */
    holds?: Record<string, Promise<void>[]>;
    /** Drop this many successful responses after the command is applied, so the next same key is a replay. */
    lose?: Record<string, number>;
    /** A draft read answers nothing, so a recovery that must see the body cannot. */
    unreadableDraft?: boolean;
    /** The next composition change omits the occurrences it inserted, so the editor has to read the recipe back. */
    dropOccurrences?: boolean;
    /** A measure write is applied even when the head it names has already moved. */
    acceptStale?: boolean;
    /**
     * Replaces one recipe read. `current` is the recipe Main holds at the moment of the read.
     * Returning nothing uses that recipe; returning a value uses it instead, so a late read can be stale.
     */
    recipe?: (current: () => { structure: string; revision: string | null; measures: Measure[];
      occurrences: { occurrence: string; parent: string; role: string; state: string; labels: { value: string; language: string }[];
        qualifier?: unknown }[] } | null) => Promise<unknown>;
  } = {};
  const holdIndex = new Map<string, number>();
  /** Commands that already committed, keyed by Idempotency-Key. A repeat is a replay, not a second apply. */
  const committed = new Map<string, { digest: string; revision: string }>();
  const answer = (data: unknown) => ({ data, error: null });
  const refuse = (status: number, code: string) => ({ data: null, error: { status, value: { code } } });
  const record = async (name: string, body?: unknown, options?: { headers?: { 'idempotency-key'?: string } }) => {
    const call = { name, body, key: options?.headers?.['idempotency-key'] };
    calls.push(call);
    interference.before?.(call);
    const queue = interference.holds?.[name];
    if (queue?.length) {
      const at = holdIndex.get(name) ?? 0;
      holdIndex.set(name, at + 1);
      await queue[Math.min(at, queue.length - 1)];
    } else await interference.gates?.[name];
    await interference.gate;
  };
  const page = () => recipe.structure ? { structure: recipe.structure, revision: recipe.head, measures: recipe.measures,
    occurrences: recipe.nodes.map(node => ({ ...node, state: 'active', labels: node.role === 'group' && node.label ? [node.label] : [] })) } : null;
  const cas = (head: string) => head === recipe.head ? null : refuse(409, 'stale_composition_head');
  const advance = () => { recipe = { ...recipe, head: next() }; return recipe.head!; };

  const compositionChanges = { post: async (body: { expectedHead: string; operations: Operation[] },
    options?: { headers?: { 'idempotency-key'?: string } }) => {
    const key = options?.headers?.['idempotency-key'];
    const digest = JSON.stringify([body.expectedHead, body.operations]);
    const prior = key ? committed.get(key) : undefined;
    if (prior) {
      await record('changes', body, options);
      if (prior.digest !== digest) return refuse(409, 'idempotency_conflict');
      // The command already ran. A sealed replay carries the receipt and not the occurrences it named.
      return answer({ structure: recipe.structure, revision: prior.revision, receipt: 'receipt', replayed: true });
    }
    await record('changes', body, options);
    const stale = cas(body.expectedHead);
    if (stale) return stale;
    const created = body.operations.filter(operation => operation.op === 'insert').map(() => next());
    recipe = { ...applyOperations(recipe, body.operations, created), head: next() };
    if (key) committed.set(key, { digest, revision: recipe.head! });
    const omit = interference.dropOccurrences === true;
    if (omit) interference.dropOccurrences = false;
    const lose = interference.lose?.changes ?? 0;
    if (lose > 0 && interference.lose) {
      interference.lose.changes = lose - 1;
      return { data: null, error: { status: 503, value: {} } };
    }
    return answer({ structure: recipe.structure, revision: recipe.head, receipt: 'receipt', replayed: omit,
      ...(omit ? {} : { occurrences: created }) });
  } };
  const measurePost = (kind: 'measures' | 'timings') => async (body: Record<string, unknown> & { expectedHead: string }, options?: never) => {
    await record(kind, body, options);
    const stale = interference.acceptStale ? null : cas(body.expectedHead);
    if (stale) return stale;
    let measures = recipe.measures;
    if (kind === 'measures') {
      const yielded = body.yield as { value: Measure['value']; unitText: string };
      const servings = body.servings as { value: Measure['value'] } | undefined;
      measures = [{ ...sampleMeasures[0]!, value: yielded.value, unitText: yielded.unitText },
        ...(servings ? [{ ...sampleMeasures[1]!, value: servings.value }] : []),
        ...measures.filter(item => item.kind !== 'yield' && item.kind !== 'servings')];
    } else {
      for (const [name, kindName] of [['preparation', 'preparation-duration'], ['cooking', 'cooking-duration'], ['total', 'total-duration']] as const) {
        if (!(name in body)) continue;
        measures = measures.filter(item => item.kind !== kindName);
        const timing = body[name] as { value: Measure['value'] } | null;
        if (timing) measures = [...measures, minutes(kindName, timing.value.numerator)];
      }
    }
    recipe = { ...recipe, measures, head: next() };
    return answer({ structure: recipe.structure, revision: recipe.head, receipt: 'receipt', replayed: false });
  };

  const main = { v1: {
    recipes: Object.assign((_: { id: string }) => ({ measures: { post: measurePost('measures') }, timings: { post: measurePost('timings') } }), {
      works: (_: { id: string }) => ({ get: async () => {
        if (!interference.recipe) return answer(page());
        const body = await interference.recipe(page);
        return answer(body === undefined ? page() : body);
      } }) }),
    compositions: Object.assign((_: { id: string }) => ({ changes: compositionChanges }), {
      post: async (body: unknown, options?: never) => {
        await record('create', body, options);
        if (!recipe.structure) recipe = { ...recipe, structure, head: next() };
        return answer({ structure, revision: recipe.head, receipt: 'receipt', replayed: false });
      } }),
    works: (_: { id: string }) => ({ metadata: {
      get: async () => answer({ revision: metadata.head, originalTitle: null, completionStatus: null,
        localized: metadata.values.entries.map(entry => ({ ...entry, mainVersionLabel: entry.label })) }),
      put: async (body: { expectedHead: string | null; state: { localized: { language: string; title: string | null; description: string | null; tagline: string | null; mainVersionLabel: string | null }[] } },
        options?: never) => {
        await record('details', body, options);
        if (body.expectedHead !== metadata.head) return refuse(409, 'stale_work_head');
        metadata = { head: next(), values: { ...metadata.values, entries: body.state.localized.map(entry => ({ language: entry.language,
          title: entry.title ?? '', description: entry.description ?? '', tagline: entry.tagline ?? '', label: entry.mainVersionLabel })) } };
        return answer({ revision: metadata.head });
      } } }),
    contributions: Object.assign((_: { contribution: string }) => ({
      get: async () => answer({ draftHead: notes.head, publicationHead: notes.publicationHead }),
      drafts: (_draft: { revision: string }) => ({ get: async () => interference.unreadableDraft
        ? refuse(404, 'draft_unreadable')
        : answer({ body: notes.body, work, language: 'en', contribution: notes.text, revision: notes.head }) }) }), {
      post: async (body: { body?: string }, options?: never) => {
        await record('notes-create', body, options);
        notes = { ...notes, text: id(300), head: next(), body: body.body ?? '' };
        return answer({ contribution: notes.text, draftRevision: notes.head });
      } }),
    'contribution-edits': { post: async (body: { body?: string; expectedHead: string }, options?: never) => {
      await record('notes-edit', body, options);
      if (body.expectedHead !== notes.head) return refuse(409, 'stale_draft');
      notes = { ...notes, head: next(), body: body.body ?? '' };
      return answer({ draftRevision: notes.head });
    } },
    'contribution-publications': { post: async (body: { expectedDraftHead: string; expectedPublicationHead?: string | null }, options?: never) => {
      await record('publish', body, options);
      // A moved draft or publication head is the refusal the editor has to recover from.
      if (body.expectedDraftHead !== notes.head || (body.expectedPublicationHead ?? null) !== (notes.publicationHead ?? null)) {
        return refuse(409, 'stale_draft');
      }
      notes = { ...notes, publicationHead: next() };
      return answer({ publicationDecision: notes.publicationHead, selectedDraft: notes.head });
    } },
    'main-versions': (_: { mainVersion: string }) => ({ selection: { get: async () => refuse(404, 'not_found') } }),
    'publication-selections': { post: async (body: unknown, options?: never) => { await record('select', body, options); return answer({ receipt: 'receipt' }); } },
  } } as unknown as MainClient;
  return { main: () => main, calls, interference, world: () => ({ recipe, notes, metadata }),
    /** Another tab's write: the head moves under the editor. */
    elsewhere: (change: (state: RecipeState) => RecipeState) => { recipe = { ...change(recipe), head: next() }; },
    /** Another tab's notes: a new draft head holding `body`. */
    elsewhereNotes: (body: string) => { notes = { ...notes, body, head: next() }; },
    advance };
}
