import { checkDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { InstructionDetails } from './instruction-reads.ts';

export type InstructionSelector =
  | { grain: 'content'; variantId: string; revision: string; block?: string }
  | { grain: 'representation'; revision: string; representation: string; fragment?: string };
export interface InstructionReference { target: string; selector: InstructionSelector }
export interface Instruction {
  occurrence: string; reference: InstructionReference; status: 'available' | 'unavailable';
  document?: DocumentSnapshot; text?: string; mediaUse?: string;
  details?: InstructionDetails;
}

export const RECIPE_METHOD_STATE = 'rezics-recipe-method-state';

/** Cooking mode can only present the complete method already disclosed and loaded on this page. */
export function recipeMethodReady(page: {
  next?: string; instructions?: readonly Instruction[];
  occurrences: readonly { occurrence: string; role: string; qualifier?: {
    type?: string; instructionText?: { value: string };
  } | null }[];
} | null): boolean {
  if (!page || page.next) return false;
  const adopted = new Map(page.instructions?.map(item => [item.occurrence, item]));
  const steps = page.occurrences.filter(item => adopted.has(item.occurrence)
    || item.role === 'step' && item.qualifier?.type === 'recipe-step');
  return steps.length > 0 && steps.every(step => {
    const selected = adopted.get(step.occurrence);
    if (!selected) return Boolean(step.qualifier?.instructionText?.value.trim());
    const document = instructionDocument(selected);
    return selected.status === 'available' && Boolean(document && checkDocument(document)
      || selected.text?.trim() || selected.details?.recording);
  });
}
export const procedureDefinition = 'https://rezics.com/definition/procedure-v1';
export const referenceDefinition = 'https://rezics.com/definition/resource-reference-v1';
export type ProcedureItem = { id: string; type: 'HowToStep'; document: DocumentSnapshot }
  | { id: string; type: 'HowToSection'; name: { value: string; language: string }; items: ProcedureItem[] };

/** Only the selected block is shown, even when Content supplies the whole exact document. */
export function instructionDocument(instruction: Instruction): DocumentSnapshot | undefined {
  const document = instruction.document;
  const selector = instruction.reference.selector;
  if (!document || selector.grain !== 'content' || !selector.block) return document;
  let selected: DocumentNode | undefined;
  const visit = (node: DocumentNode) => {
    if (node.attrs?.id === selector.block) selected = node;
    node.content?.forEach(visit);
  };
  visit(document.doc);
  return selected ? { ...document, doc: { type: 'doc', content: [selected] } } : undefined;
}

/** A continuation retains ordered uses, including two uses of the same Content revision. */
export function appendInstructions(current: readonly Instruction[] = [], incoming: readonly Instruction[] = []): Instruction[] {
  const seen = new Set(current.map(item => item.occurrence));
  return [...current, ...incoming.filter(item => !seen.has(item.occurrence))];
}

export function instructionSelection(reference: InstructionReference) {
  return { mode: 'fixed-revision' as const, revision: reference.selector.revision, selector: reference.selector };
}

