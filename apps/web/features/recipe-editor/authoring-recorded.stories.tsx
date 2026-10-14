import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import authoringJson from '../../../../tests/qa/fixtures/outcomes/recipes/author-a-recipe.json';
import exchangeJson from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { RecipeAuthoringRecordedVisit } from './authoring-recorded-visit.tsx';
import { readingLine } from './ingredient-line.ts';
import { copyOf } from './messages.ts';
import { stateOf } from './model.ts';
import { recipeProveStates } from './prove-states.ts';

const authoring = authoringJson as AnswerRecord, exchange = exchangeJson as AnswerRecord;
const reads = (record: AnswerRecord, persona: AnswerPersona): RecordedSelection[] => record.personas[persona]
  .filter(item => item.label.startsWith('editor-')).map(item => ({ label: item.label, state: 'populated' }));
const meta = {
  title: 'Recipe editor/Recorded production visit', component: RecipeAuthoringRecordedVisit,
  args: { record: authoring, persona: 'owner' as const, selections: reads(authoring, 'owner'), locale: 'en' as const },
  globals: { viewport: { value: 'desktop' }, locale: 'en' },
  parameters: { controls: { disable: true }, recipeProveStates,
    docs: { description: { component: 'Production editor body and edit layout, with unchanged persona-bound answers. The locale layout’s Account content-preferences viewer and missing registry/frame reads remain prove seams, listed in recipeProveStates.' } } },
} satisfies Meta<typeof RecipeAuthoringRecordedVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const }, locale: 'en' } };

const owner: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement), t = copyOf(args.locale);
  const record = args.record as AnswerRecord;
  const recipe = record.personas.owner.find(item => item.label === 'editor-recipe-draft' || item.label === 'editor-recipe')!;
  const state = stateOf(recipe.answer as Parameters<typeof stateOf>[0]);
  const title = record.personas.owner.find(item => item.label === 'editor-resource-summary')!.answer as { name: { value: string } };
  await expect(await canvas.findByRole('textbox', { name: t.title })).toHaveValue(title.name.value);
  const region = within(canvas.getByRole('region', { name: t.ingredientsHeading }));
  for (const line of state.nodes.filter(node => node.role === 'ingredient')) {
    await expect(region.getByText(readingLine(line.qualifier))).toBeVisible();
  }
  await expect(canvasElement.querySelectorAll('[data-line]')).toHaveLength(2);
  for (const [index, step] of state.nodes.filter(node => node.role === 'step').entries()) {
    await expect(canvas.getByRole('textbox', { name: t.stepText({ number: String(index + 1) }) })).toHaveValue(step.qualifier.instructionText.value);
  }
  await expect(canvas.queryByRole('alert')).toBeNull();
};
const refused: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement), t = editCopy(args.locale);
  await expect(await canvas.findByText(args.persona === 'visitor' ? t.signInTitle : t.noAuthorityTitle)).toBeVisible();
  await expect(canvas.queryByRole('textbox', { name: copyOf(args.locale).title })).toBeNull();
  await expect(canvas.queryByRole('button', { name: copyOf(args.locale).publish })).toBeNull();
};
const peer = (persona: AnswerPersona, record = authoring): Story => ({ args: { persona, record, selections: reads(record, persona) }, play: refused });

export const OwnerDraft: Story = { play: owner };
export const OwnerDraftPhone: Story = { ...OwnerDraft, ...phone };
export const OwnerExchange: Story = { args: { record: exchange, selections: reads(exchange, 'owner') }, play: owner };
export const OwnerExchangePhone: Story = { ...OwnerExchange, ...phone };
export const Visitor: Story = peer('visitor');
export const VisitorPhone: Story = { ...Visitor, ...phone };
export const StrangerPeer: Story = peer('stranger');
export const StrangerPeerPhone: Story = { ...StrangerPeer, ...phone };
export const MemberPeer: Story = peer('member');
export const MemberPeerPhone: Story = { ...MemberPeer, ...phone };
export const ModeratorPeer: Story = peer('moderator');
export const ModeratorPeerPhone: Story = { ...ModeratorPeer, ...phone };
export const OperatorPeer: Story = peer('operator');
export const OperatorPeerPhone: Story = { ...OperatorPeer, ...phone };
export const Loading: Story = {
  args: { selections: [{ label: 'editor-authority', state: 'populated' }, { label: 'editor-work-header', state: 'loading' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(copyOf('en').loadingRecipe);
    await expect(canvas.queryByRole('textbox', { name: copyOf('en').title })).toBeNull();
  },
};
export const LoadingPhone: Story = { ...Loading, ...phone };
