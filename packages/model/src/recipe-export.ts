import { nativeExportCheckpoint, nativeExportContents, continueNativeExport, assembleNativeExport, type NativeExportCheckpoint } from './native-export.ts';
/** Recipe export continuation protocol. Projection and disclosure belong to Main;
 * clients only join ordered parts and retain their checkpoint between requests. */
export interface RecipeExportLoss { occurrence: string; code: string; pointer: string }
export interface RecipeExportPart {
  occurrence: string;
  parent: string;
  group: boolean;
  adopted: boolean;
  ingredient?: Record<string, unknown>;
  instructions: Record<string, unknown>[];
  residuals: unknown[];
  sourceObservations: string[];
  losses: RecipeExportLoss[];
  unsupportedUnit?: string;
}
export interface RecipeExportPage {
  profile: 'recipe-export-page-v1';
  structure: string;
  revision: string;
  parent: string;
  next: string | null;
  occurrences: unknown[];
  instructions: unknown[];
  contents: { reference: { target: string; selector: { grain: string; revision?: string } }; document?: unknown; body?: string }[];
  parts: RecipeExportPart[];
  measures: unknown[];
  rights: unknown[];
  importLimits: { bytes: number; occurrences: number; depth: number };
  cost: { pagesRead: number; occurrences: number };
}

export type RecipeExportCheckpoint = NativeExportCheckpoint<RecipeExportPage>;
export const recipeExportCheckpoint = (structure: string): RecipeExportCheckpoint => nativeExportCheckpoint<RecipeExportPage>(structure);
export const recipeExportContents = nativeExportContents;

export async function continueRecipeExport(checkpoint: RecipeExportCheckpoint,
  readPage: (parent: string, after?: string) => Promise<RecipeExportPage>,
  readDerivations: (revision: string, cursor?: string) => Promise<{ items: unknown[]; nextCursor: string | null }>) {
  return continueNativeExport(checkpoint, readPage, readDerivations,
    page => page.parts.filter(part => part.group).map(part => part.occurrence));
}

/** Joining is deterministic: occurrences use breadth-first sibling order, while
 * HowTo sections and their losses use the original depth-first display order. */
export function assembleRecipeExport(pages: readonly RecipeExportPage[], derivations: unknown[], format: 'native' | 'schema-org') {
  const first = pages[0];
  if (!first) throw new Error('Recipe export has no pages');
  const { structure, revision, rights, measures, importLimits } = first;
  if (pages.some(page => page.structure !== structure || page.revision !== revision)) throw new Error('Recipe export revisions differ');
  if (format === 'native') return { ...assembleNativeExport(pages, derivations),
    instructions: pages.flatMap(page => page.instructions), losses: [] as RecipeExportLoss[] };

  const parts = pages.flatMap(page => page.parts);
  const ingredients = parts.flatMap(part => part.ingredient ? [part.ingredient] : []);
  const losses: RecipeExportLoss[] = [];
  const instructionLosses = new Map<string, RecipeExportLoss[]>();
  const children = new Map<string, RecipeExportPart[]>();
  let adoptedIndex = 0;
  for (const [index, part] of parts.entries()) {
    const siblings = children.get(part.parent) ?? [];
    siblings.push(part); children.set(part.parent, siblings);
    const remapped = part.losses.map(loss => ({ ...loss, pointer: loss.pointer
      .replace(/^\/occurrences\/0(?=\/|$)/, `/occurrences/${index}`)
      .replace(/^\/instructions\/0(?=\/|$)/, `/instructions/${adoptedIndex}`) }));
    if (part.adopted) adoptedIndex++;
    if (part.ingredient) losses.push(...remapped);
    else instructionLosses.set(part.occurrence, remapped);
  }
  measures.forEach((_measure, index) => losses.push({ occurrence: structure,
    code: 'measurement-not-representable', pointer: `/measures/${index}` }));
  let instructionCount = 0;
  const visit = (parent: string, depth = 0): Record<string, unknown>[] => (children.get(parent) ?? []).flatMap(part => {
    if (depth > 16) throw new Error('Recipe section depth exceeds 16');
    losses.push(...instructionLosses.get(part.occurrence) ?? []);
    if (part.group || part.adopted || part.instructions.length) instructionCount++;
    const instructions = structuredClone(part.instructions);
    if (part.group && instructions[0]) instructions[0].itemListElement = visit(part.occurrence, depth + 1);
    return instructions;
  });
  const recipe = { '@context': 'https://schema.org', '@type': 'Recipe',
    recipeIngredient: [...ingredients, ...ingredients.map(line => line.text as string)],
    recipeInstructions: visit(structure) };
  const bytes = new TextEncoder().encode(JSON.stringify(recipe)).byteLength;
  const depthOf = (value: unknown): number => {
    let depth = 0;
    if (value && typeof value === 'object') for (const child of Object.values(value)) depth = Math.max(depth, 1 + depthOf(child));
    return depth;
  };
  const measured = { bytes, occurrences: ingredients.length + instructionCount, depth: depthOf(recipe) };
  let importability: Record<string, unknown> = { status: 'importable' };
  for (const limit of ['bytes', 'occurrences', 'depth'] as const) {
    if (measured[limit] > importLimits[limit]) {
      importability = { status: 'not-importable', code: 'recipe_not_importable', limit,
        measured: measured[limit], allowed: importLimits[limit] }; break;
    }
  }
  const unsupportedUnit = parts.find(part => part.unsupportedUnit)?.unsupportedUnit;
  if (importability.status === 'importable' && unsupportedUnit) importability = {
    status: 'not-importable', code: 'recipe_unit_not_registered', unit: unsupportedUnit };
  const derivationRevisions = derivations.map(item => (item as { output: { selector: { revision: string } } }).output.selector.revision);
  const occurrences = new Map(pages.flatMap(page => page.occurrences).map(item => [(item as { occurrence: string }).occurrence, item]));
  const derivationIndices = new Map<string, number>();
  derivationRevisions.forEach((revision, index) => { if (!derivationIndices.has(revision)) derivationIndices.set(revision, index); });
  parts.forEach(part => {
    const record = occurrences.get(part.occurrence) as { selection?: { mode: string; revision: string; selector?: { grain: string } } } | undefined;
    if (record?.selection?.mode === 'fixed-revision' && record.selection.selector?.grain === 'content') {
      const index = derivationIndices.get(record.selection.revision);
      if (index !== undefined) losses.push({ code: 'derivation-not-representable', occurrence: part.occurrence, pointer: `/derivations/${index}` });
    }
  });
  return { profile: 'recipe-schema-org-export-v1' as const, structure, revision, rights, recipe,
    residuals: parts.flatMap(part => part.residuals),
    sourceObservations: [...new Set(parts.flatMap(part => part.sourceObservations))], importability, losses };
}
