import type { IngredientQualifier } from './ingredient-line.ts';
import type { Rational } from './quantity.ts';

// The recipe as the editor holds it: Main's Composition occurrences in reading order (each parent's
// children in their order), and the measures stored with the head they were read at. Occurrence
// identity is Main's, so an edit that changes an ingredient's text keeps the steps that use it.

export interface StepQualifier {
  type: 'recipe-step';
  instructionText: { value: string; language: string };
  usesIngredient: string[];
  media: string[];
  scaling: 'linear' | 'non-linear' | 'not-scalable';
}

interface Base { occurrence: string; parent: string }
export type GroupNode = Base & { role: 'group'; label: { value: string; language: string } | null };
export type IngredientNode = Base & { role: 'ingredient'; qualifier: IngredientQualifier };
export type StepNode = Base & { role: 'step'; qualifier: StepQualifier };
/** Equipment and anything else Main holds: kept in order, never edited here. */
export type OtherNode = Base & { role: 'equipment' | 'chapter' | 'part' | 'member' | 'mount' | 'navigation' };
export type Node = GroupNode | IngredientNode | StepNode | OtherNode;

export interface Measure {
  kind: 'yield' | 'servings' | 'preparation-duration' | 'cooking-duration' | 'total-duration' | 'nutrient';
  value: Rational;
  unit?: string;
  unitText?: string;
  [more: string]: unknown;
}

export interface RecipeState {
  /** Main's Composition for the recipe; null until the first write creates it. */
  structure: string | null;
  head: string | null;
  nodes: Node[];
  measures: Measure[];
}

export const emptyRecipe: RecipeState = { structure: null, head: null, nodes: [], measures: [] };

/** What Main's recipe page answers (`GET /v1/recipes/works/{id}`), as far as the editor reads it. */
export interface RecipePageLike {
  structure: string;
  revision: string;
  occurrences: readonly { occurrence: string; parent: string; role: string; state: string;
    labels: readonly { value: string; language: string }[]; qualifier?: { type: string } }[];
  measures: readonly { kind: string; value: Rational; [more: string]: unknown }[];
  /** Present when a later page of this revision is still unread. */
  next?: string;
}

export function stateOf(page: RecipePageLike | null): RecipeState {
  if (!page) return emptyRecipe;
  const nodes = page.occurrences.filter(item => item.state === 'active').flatMap((item): Node[] => {
    const base = { occurrence: item.occurrence, parent: item.parent };
    if (item.role === 'group') return [{ ...base, role: 'group', label: item.labels[0] ?? null }];
    if (item.role === 'ingredient' && item.qualifier?.type === 'ingredient-line') {
      return [{ ...base, role: 'ingredient', qualifier: item.qualifier as IngredientQualifier }];
    }
    if (item.role === 'step' && item.qualifier?.type === 'recipe-step') {
      return [{ ...base, role: 'step', qualifier: item.qualifier as unknown as StepQualifier }];
    }
    return [{ ...base, role: item.role as OtherNode['role'] }];
  });
  return { structure: page.structure, head: page.revision, nodes, measures: page.measures as Measure[] };
}

export const groups = (state: RecipeState) => state.nodes.filter((node): node is GroupNode => node.role === 'group');
export const ingredients = (state: RecipeState) => state.nodes.filter((node): node is IngredientNode => node.role === 'ingredient');
export const steps = (state: RecipeState) => state.nodes.filter((node): node is StepNode => node.role === 'step');

/** The ingredients directly under `parent` (a group's occurrence, or the Structure for the unsectioned ones), in order. */
export const linesOf = (state: RecipeState, parent: string | null) =>
  ingredients(state).filter(node => node.parent === (parent ?? state.structure));

export const siblings = (state: RecipeState, parent: string) => state.nodes.filter(node => node.parent === parent);
export const nodeOf = (state: RecipeState, occurrence: string) => state.nodes.find(node => node.occurrence === occurrence);

const MEASURE_KINDS = { yield: 'yield', servings: 'servings', preparation: 'preparation-duration',
  cooking: 'cooking-duration', total: 'total-duration' } as const;
export type TimingName = 'preparation' | 'cooking' | 'total';
export const measureOf = (state: RecipeState, name: keyof typeof MEASURE_KINDS) =>
  state.measures.find(item => item.kind === MEASURE_KINDS[name]);

const MINUTE_UNITS = new Set(['min', 'mins', 'minute', 'minutes']);
const HOUR_UNITS = new Set(['h', 'hr', 'hrs', 'hour', 'hours']);

/**
 * A stored timing in minutes, as the field edits it. A timing in a unit the field cannot express
 * (days, an IRI unit) has no minutes: the field leaves it as it is.
 */
export function minutesOf(measure: Measure | undefined): number | 'other' | null {
  if (!measure) return null;
  const unit = (measure.unitText ?? '').trim().toLowerCase();
  const factor = MINUTE_UNITS.has(unit) ? 1 : HOUR_UNITS.has(unit) ? 60 : 0;
  if (!factor || measure.unit) return 'other';
  const minutes = (measure.value.numerator * factor) / measure.value.denominator;
  return Number.isInteger(minutes) ? minutes : 'other';
}
