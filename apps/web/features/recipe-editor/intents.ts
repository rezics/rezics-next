import { type IngredientQualifier, sameQualifier } from './ingredient-line.ts';
import { ingredients, type Measure, measureOf, minutesOf, type Node, nodeOf, type RecipeState, siblings,
  type StepQualifier, type TimingName } from './model.ts';
import { type Rational, sameRational } from './quantity.ts';

// What a cook did, as something that can be worked out again against newer state. A write that
// Main refuses because the head moved is not replayed from a stale plan: the editor reads Main
// again and plans the same intent over what is there now (`plan`), which may turn out to be
// already done (`moot`) or about something that is gone (`invalid`).

type Label = { value: string; language: string };
export type Position = 'first' | 'last' | { after: string };
export type Operation =
  | { op: 'insert'; parent: string; position: Position; role: 'group' | 'ingredient' | 'step'; label?: Label;
    qualifier?: IngredientQualifier | StepQualifier }
  | { op: 'update'; occurrence: string; label?: Label; qualifier?: IngredientQualifier | StepQualifier }
  | { op: 'move'; occurrence: string; parent: string; position: Position }
  | { op: 'remove'; occurrence: string };

/** Main accepts at most this many operations in one change; an intent is one change, never several. */
export const MAX_OPERATIONS = 16;

export type Direction = 'up' | 'down';
export type Intent =
  | { kind: 'addSection'; label: string; language: string }
  | { kind: 'renameSection'; occurrence: string; label: string; language: string }
  | { kind: 'removeSection'; occurrence: string }
  | { kind: 'moveSection'; occurrence: string; direction: Direction }
  | { kind: 'addLine'; section: string | null; qualifier: IngredientQualifier }
  | { kind: 'editLine'; occurrence: string; qualifier: IngredientQualifier }
  | { kind: 'removeLine'; occurrence: string }
  | { kind: 'moveLine'; occurrence: string; direction: Direction }
  | { kind: 'moveLineTo'; occurrence: string; section: string | null }
  | { kind: 'addStep'; text: string; language: string; uses: readonly string[] }
  | { kind: 'editStep'; occurrence: string; text: string; uses: readonly string[] }
  | { kind: 'removeStep'; occurrence: string }
  | { kind: 'moveStep'; occurrence: string; direction: Direction }
  | { kind: 'yield'; yield: { value: Rational; unitText: string } | null; servings: Rational | null; servingsWord: string }
  | { kind: 'timings'; times: Partial<Record<TimingName, number | null>> };

export type Reason = 'gone' | 'too-many' | 'yield-required';
type MeasureBody = { value: Rational; unitText: string; coverage: 'complete'; provenance: 'declared' };
export type Plan =
  | { kind: 'changes'; operations: Operation[] }
  | { kind: 'yield'; body: { yield: MeasureBody; servings?: Omit<MeasureBody, 'unitText'> } }
  | { kind: 'timings'; body: Partial<Record<TimingName, MeasureBody | null>> }
  | { kind: 'moot' }
  | { kind: 'invalid'; reason: Reason };

const moot: Plan = { kind: 'moot' };
const invalid = (reason: Reason): Plan => ({ kind: 'invalid', reason });
const changes = (operations: Operation[]): Plan => operations.length > MAX_OPERATIONS ? invalid('too-many')
  : operations.length ? { kind: 'changes', operations } : moot;

/** Where `occurrence` goes to sit one place above or below its nearest sibling of the same kind. */
function stepOver(state: RecipeState, node: Node, direction: Direction): Operation | null {
  const row = siblings(state, node.parent);
  const index = row.findIndex(item => item.occurrence === node.occurrence);
  const sameKind = (item: Node) => item.role === node.role;
  if (direction === 'up') {
    const target = row.slice(0, index).findLast(sameKind);
    if (!target) return null;
    const before = row[row.indexOf(target) - 1];
    return { op: 'move', occurrence: node.occurrence, parent: node.parent, position: before ? { after: before.occurrence } : 'first' };
  }
  const target = row.slice(index + 1).find(sameKind);
  return target ? { op: 'move', occurrence: node.occurrence, parent: node.parent, position: { after: target.occurrence } } : null;
}

const known = (state: RecipeState, occurrences: readonly string[]) => {
  const live = new Set(ingredients(state).map(node => node.occurrence));
  return [...new Set(occurrences)].filter(id => live.has(id));
};

/** Updates that take `gone` away from every step and substitution that names it. */
function unreference(state: RecipeState, gone: ReadonlySet<string>, removing: ReadonlySet<string>): Operation[] {
  const operations: Operation[] = [];
  for (const node of state.nodes) {
    if (removing.has(node.occurrence)) continue;
    if (node.role === 'step' && node.qualifier.usesIngredient.some(id => gone.has(id))) {
      operations.push({ op: 'update', occurrence: node.occurrence,
        qualifier: { ...node.qualifier, usesIngredient: node.qualifier.usesIngredient.filter(id => !gone.has(id)) } });
    } else if (node.role === 'ingredient' && node.qualifier.substituteFor.some(id => gone.has(id))) {
      operations.push({ op: 'update', occurrence: node.occurrence,
        qualifier: { ...node.qualifier, substituteFor: node.qualifier.substituteFor.filter(id => !gone.has(id)) } });
    }
  }
  return operations;
}

function stepQualifier(text: string, language: string, uses: readonly string[], previous?: StepQualifier): StepQualifier {
  return { type: 'recipe-step', instructionText: { value: text.trim(), language: previous?.instructionText.language ?? language },
    usesIngredient: uses as string[], media: previous?.media ?? [], scaling: previous?.scaling ?? 'linear' };
}

const sameStep = (a: StepQualifier, b: StepQualifier) => a.instructionText.value === b.instructionText.value
  && a.usesIngredient.length === b.usesIngredient.length && a.usesIngredient.every((id, index) => id === b.usesIngredient[index]);

function measureBody(value: Rational, unitText: string): MeasureBody {
  return { value, unitText, coverage: 'complete', provenance: 'declared' };
}

const sameMeasure = (stored: Measure | undefined, value: Rational | undefined, unitText?: string) =>
  stored ? value !== undefined && sameRational(stored.value, value) && (unitText === undefined || stored.unitText === unitText)
    : value === undefined;

export function plan(state: RecipeState, intent: Intent): Plan {
  const root = state.structure ?? '';
  switch (intent.kind) {
    case 'addSection':
      return changes([{ op: 'insert', parent: root, position: 'last', role: 'group',
        label: { value: intent.label.trim(), language: intent.language } }]);
    case 'renameSection': {
      const node = nodeOf(state, intent.occurrence);
      if (node?.role !== 'group') return invalid('gone');
      return node.label?.value === intent.label.trim() ? moot
        : changes([{ op: 'update', occurrence: node.occurrence, label: { value: intent.label.trim(), language: intent.language } }]);
    }
    case 'moveSection': case 'moveLine': case 'moveStep': {
      const node = nodeOf(state, intent.occurrence);
      const role = intent.kind === 'moveSection' ? 'group' : intent.kind === 'moveLine' ? 'ingredient' : 'step';
      if (node?.role !== role) return invalid('gone');
      const operation = stepOver(state, node, intent.direction);
      return operation ? changes([operation]) : moot;
    }
    case 'moveLineTo': {
      const node = nodeOf(state, intent.occurrence);
      const parent = intent.section ?? root;
      if (node?.role !== 'ingredient' || (intent.section && nodeOf(state, intent.section)?.role !== 'group')) return invalid('gone');
      return node.parent === parent ? moot : changes([{ op: 'move', occurrence: node.occurrence, parent, position: 'last' }]);
    }
    case 'removeSection': {
      const group = nodeOf(state, intent.occurrence);
      if (group?.role !== 'group') return moot;
      const children = siblings(state, group.occurrence);
      // A section inside a section is not something this editor makes; it is never removed unseen.
      if (children.some(child => child.role === 'group')) return invalid('too-many');
      const removing = new Set([group.occurrence, ...children.map(child => child.occurrence)]);
      const gone = new Set(children.filter(child => child.role === 'ingredient').map(child => child.occurrence));
      return changes([...unreference(state, gone, removing),
        ...children.map((child): Operation => ({ op: 'remove', occurrence: child.occurrence })),
        { op: 'remove', occurrence: group.occurrence }]);
    }
    case 'addLine': {
      if (intent.section && nodeOf(state, intent.section)?.role !== 'group') return invalid('gone');
      return changes([{ op: 'insert', parent: intent.section ?? root, position: 'last', role: 'ingredient', qualifier: intent.qualifier }]);
    }
    case 'editLine': {
      const node = nodeOf(state, intent.occurrence);
      if (node?.role !== 'ingredient') return invalid('gone');
      return sameQualifier(node.qualifier, intent.qualifier) ? moot
        : changes([{ op: 'update', occurrence: node.occurrence, qualifier: intent.qualifier }]);
    }
    case 'removeLine': {
      const node = nodeOf(state, intent.occurrence);
      if (node?.role !== 'ingredient') return moot;
      return changes([...unreference(state, new Set([node.occurrence]), new Set([node.occurrence])),
        { op: 'remove', occurrence: node.occurrence }]);
    }
    case 'addStep':
      return changes([{ op: 'insert', parent: root, position: 'last', role: 'step',
        qualifier: stepQualifier(intent.text, intent.language, known(state, intent.uses)) }]);
    case 'editStep': {
      const node = nodeOf(state, intent.occurrence);
      if (node?.role !== 'step') return invalid('gone');
      const next = stepQualifier(intent.text, node.qualifier.instructionText.language, known(state, intent.uses), node.qualifier);
      return sameStep(node.qualifier, next) ? moot : changes([{ op: 'update', occurrence: node.occurrence, qualifier: next }]);
    }
    case 'removeStep':
      return nodeOf(state, intent.occurrence)?.role === 'step' ? changes([{ op: 'remove', occurrence: intent.occurrence }]) : moot;
    case 'yield': {
      const wanted = intent.yield ?? (intent.servings ? { value: intent.servings, unitText: intent.servingsWord } : null);
      const storedYield = measureOf(state, 'yield');
      const storedServings = measureOf(state, 'servings');
      if (!wanted) return storedYield ? invalid('yield-required') : storedServings ? invalid('yield-required') : moot;
      if (sameMeasure(storedYield, wanted.value, wanted.unitText) && sameMeasure(storedServings, intent.servings ?? undefined)) return moot;
      return { kind: 'yield', body: { yield: measureBody(wanted.value, wanted.unitText),
        ...(intent.servings ? { servings: { value: intent.servings, coverage: 'complete' as const, provenance: 'declared' as const } } : {}) } };
    }
    case 'timings': {
      const body: Partial<Record<TimingName, MeasureBody | null>> = {};
      for (const name of ['preparation', 'cooking', 'total'] as const) {
        const wanted = intent.times[name];
        if (wanted === undefined) continue;
        const stored = minutesOf(measureOf(state, name));
        if (wanted === null) { if (stored !== null) body[name] = null; continue; }
        if (stored !== wanted) body[name] = measureBody({ numerator: wanted, denominator: 1 }, 'min');
      }
      return Object.keys(body).length ? { kind: 'timings', body } : moot;
    }
  }
}

// -- local application ------------------------------------------------------------------------

function place(nodes: Node[], node: Node, position: Position): Node[] {
  const rest = nodes.filter(item => item.occurrence !== node.occurrence);
  const row = rest.filter(item => item.parent === node.parent);
  let at: number;
  if (position === 'first') at = row.length ? rest.indexOf(row[0]!) : rest.length;
  else if (position === 'last') at = row.length ? rest.indexOf(row.at(-1)!) + 1 : rest.length;
  else {
    const after = rest.findIndex(item => item.occurrence === position.after);
    at = after < 0 ? (row.length ? rest.indexOf(row.at(-1)!) + 1 : rest.length) : after + 1;
  }
  return [...rest.slice(0, at), node, ...rest.slice(at)];
}

/** The state after Main accepted `operations`; `created` are the occurrences it named for the inserts, in order. */
export function applyOperations(state: RecipeState, operations: readonly Operation[], created: readonly string[]): RecipeState {
  let nodes = state.nodes;
  let next = 0;
  for (const operation of operations) {
    if (operation.op === 'insert') {
      const occurrence = created[next++];
      if (!occurrence) continue;
      const base = { occurrence, parent: operation.parent };
      const node: Node = operation.role === 'group' ? { ...base, role: 'group', label: operation.label ?? null }
        : operation.role === 'ingredient' ? { ...base, role: 'ingredient', qualifier: operation.qualifier as IngredientQualifier }
          : { ...base, role: 'step', qualifier: operation.qualifier as StepQualifier };
      nodes = place(nodes, node, operation.position);
    } else if (operation.op === 'update') {
      nodes = nodes.map(node => {
        if (node.occurrence !== operation.occurrence) return node;
        if (node.role === 'group') return operation.label ? { ...node, label: operation.label } : node;
        if (operation.qualifier && node.role === 'ingredient') return { ...node, qualifier: operation.qualifier as IngredientQualifier };
        if (operation.qualifier && node.role === 'step') return { ...node, qualifier: operation.qualifier as StepQualifier };
        return node;
      });
    } else if (operation.op === 'move') {
      const node = nodes.find(item => item.occurrence === operation.occurrence);
      if (node) nodes = place(nodes, { ...node, parent: operation.parent }, operation.position);
    } else nodes = nodes.filter(node => node.occurrence !== operation.occurrence);
  }
  return { ...state, nodes };
}

const stored = (kind: Measure['kind'], body: MeasureBody): Measure => ({ kind, value: body.value, unitText: body.unitText,
  basis: 'whole-recipe', coverage: body.coverage, provenance: body.provenance });

/** The state after Main accepted a plan at `revision`. */
export function applyPlan(state: RecipeState, planned: Plan, revision: string, created: readonly string[]): RecipeState {
  if (planned.kind === 'changes') return { ...applyOperations(state, planned.operations, created), head: revision };
  if (planned.kind === 'yield') {
    const kept = state.measures.filter(item => item.kind !== 'yield' && item.kind !== 'servings');
    const { servings } = planned.body;
    return { ...state, head: revision, measures: [stored('yield', planned.body.yield), ...(servings
      ? [stored('servings', { ...servings, unitText: 'servings' })] : []), ...kept] };
  }
  if (planned.kind === 'timings') {
    const kinds = { preparation: 'preparation-duration', cooking: 'cooking-duration', total: 'total-duration' } as const;
    let measures = state.measures;
    for (const name of ['preparation', 'cooking', 'total'] as const) {
      const body = planned.body[name];
      if (body === undefined) continue;
      measures = measures.filter(item => item.kind !== kinds[name]);
      if (body) measures = [...measures, stored(kinds[name], body)];
    }
    return { ...state, head: revision, measures };
  }
  return state;
}

