import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentSnapshot } from '@rezics/document';
import { englishMessages } from '../work-page/messages.ts';
import { RecipeContent } from '../work-page/types/recipe.tsx';
import { applyPlan, plan } from './intents.ts';
import { instructionDocument, instructionSelection, procedureDefinition, type Instruction } from './instructions.ts';
import { stateOf, type RecipePageLike } from './model.ts';
import { appendRecipePage } from './pages.ts';
import { readingOf } from './reading.ts';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const revision = '00000000-0000-4000-8000-000000000021';
const paragraph = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const document: DocumentSnapshot = { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [
  paragraph('outside-selection', 'This is outside the selected procedure.'),
  { type: 'extensionBlock', attrs: { id: 'method', definition: procedureDefinition, version: '1', fallback: 'Procedure', payload: { items: [
    { id: 'first', type: 'HowToStep', document: { version: 'rezics-document-v1', profile: 'blocks', doc: {
      type: 'doc', content: [paragraph('stir', 'Stir the tomatoes into the stock.')],
    } } },
    { id: 'empty-section', type: 'HowToSection', name: { value: 'אחר כך', language: 'he' }, items: [] },
  ] } } },
] } };
const instruction: Instruction = { occurrence: iri(1), status: 'available',
  reference: { target: iri(2), selector: { grain: 'content', variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000020', revision, block: 'method' } }, document };
const page: RecipePageLike = { structure: iri(3), revision: iri(4), measures: [], instructions: [instruction], occurrences: [
  { occurrence: instruction.occurrence, state: 'active', role: 'instruction', parent: iri(3), labels: [],
    target: instruction.reference.target, selection: instructionSelection(instruction.reference) },
] };

test('reading and private preview retain exact selections and render only the selected Content procedure', () => {
  const state = stateOf(page);
  expect(state.nodes[0]).toMatchObject({ role: 'instruction', reference: instruction.reference });
  expect(readingOf(state).instructions).toEqual([instruction]);
  const html = renderToStaticMarkup(createElement(RecipeContent, { page: readingOf(state), units: 'written', messages: englishMessages }));
  expect(html).toContain('Stir the tomatoes into the stock.');
  expect(html).toContain('אחר כך');
  expect(html).toContain('dir="rtl"');
  expect(html).not.toContain('outside the selected procedure');
  expect(instructionDocument({ ...instruction, reference: { ...instruction.reference,
    selector: { ...instruction.reference.selector, grain: 'content', variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000020', block: 'missing' } } })).toBeUndefined();
});

test('the same selected procedure remains two ordered uses across continuation, adoption and removal', () => {
  const duplicate = { ...instruction, occurrence: iri(5) };
  const first: RecipePageLike & { ingredients: [] } = { ...page, ingredients: [], next: 'opaque' };
  const second: RecipePageLike & { ingredients: [] } = { ...page, ingredients: [], next: undefined,
    instructions: [duplicate], occurrences: [{ ...page.occurrences[0]!, occurrence: duplicate.occurrence }] };
  const complete = appendRecipePage(first, second);
  expect(complete.instructions?.map(item => item.occurrence)).toEqual([iri(1), iri(5)]);
  const state = stateOf(complete);
  const adoption = plan(state, { kind: 'adoptInstruction', reference: instruction.reference });
  expect(adoption).toMatchObject({ kind: 'changes', operations: [{ target: iri(2), selection: instructionSelection(instruction.reference) }] });
  const applied = applyPlan(state, adoption, iri(8), [iri(6)]);
  expect(applied.nodes.map(item => item.occurrence)).toEqual([iri(1), iri(5), iri(6)]);
  const removal = plan(applied, { kind: 'removeInstruction', occurrence: iri(5) });
  expect(removal).toEqual({ kind: 'changes', operations: [{ op: 'remove', occurrence: iri(5) }] });
  expect(plan(applied, { kind: 'moveInstruction', occurrence: iri(6), direction: 'up' })).toEqual({ kind: 'changes', operations: [
    { op: 'move', occurrence: iri(6), parent: iri(3), position: { after: iri(1) } },
  ] });
});

test('unavailable selections remain explicit and do not fall back to unselected Content', () => {
  const html = renderToStaticMarkup(createElement(RecipeContent, {
    page: readingOf(stateOf({ ...page, instructions: [{ ...instruction, status: 'unavailable' }] })),
    units: 'written', messages: englishMessages,
  }));
  expect(html).toContain(englishMessages.contentsUnavailable);
  expect(html).not.toContain('Stir the tomatoes');
});

test('reading and editor preview keep written steps interleaved with adopted instructions', () => {
  const written = (occurrence: string, text: string) => ({ occurrence, parent: page.structure, role: 'step',
    state: 'active', labels: [], qualifier: { type: 'recipe-step', instructionText: { value: text, language: 'en' },
      usesIngredient: [], media: [], scaling: 'linear' } });
  const mixed = stateOf({ ...page, occurrences: [written(iri(10), 'Prepare the pan.'), page.occurrences[0]!,
    written(iri(11), 'Serve while warm.')] });
  const html = renderToStaticMarkup(createElement(RecipeContent, {
    page: readingOf(mixed), units: 'written', messages: englishMessages,
  }));
  expect(html).toContain('Prepare the pan.');
  expect(html).toContain('Serve while warm.');
  expect(html.indexOf('Prepare the pan.')).toBeLessThan(html.indexOf('Stir the tomatoes'));
  expect(html.indexOf('Stir the tomatoes')).toBeLessThan(html.indexOf('Serve while warm.'));
});

test('recipe method markers retain occurrence identity and selected document text separately from credit', () => {
  const credited = { ...instruction, details: { author: iri(9), creditNames: { [iri(9)]: 'Actual instruction author' }, refusals: [] } };
  const html = renderToStaticMarkup(createElement(RecipeContent, {
    page: readingOf(stateOf({ ...page, instructions: [credited] })), units: 'written', messages: englishMessages,
  }));
  expect(html).toContain(`data-step-occurrence="${instruction.occurrence}"`);
  expect(html).toContain(`data-step-text="${instruction.occurrence}"`);
  const body = html.match(/data-step-text="[^"]+"[^>]*>(.*?)<\/div><p class="text-xs text-muted-foreground">Author:/s)?.[1];
  expect(body).toContain('Stir the tomatoes into the stock.');
  expect(body).toContain('אחר כך');
  expect(body).not.toContain('Actual instruction author');
  expect(html).toContain('Actual instruction author');
  expect(html).not.toContain('outside the selected procedure');
});
