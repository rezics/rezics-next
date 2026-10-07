import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { RecipeEditor } from './editor.tsx';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { actingSubject, detailsValues, emptyStart, fakeMain, id, mainVersion, noNotes, startRecipe, work } from './fixtures.ts';
import { copyOf, messages } from './messages.ts';
import type { RecipeState } from './model.ts';
import type { NotesState } from './saves.ts';

let current: ReturnType<typeof fakeMain>;

function Page({ locale, start, notes }: { locale: UiLocale; start: RecipeState; notes?: NotesState }) {
  const [fake] = useState(() => (current = fakeMain({ recipe: start, notes })));
  return <div className="mx-auto max-w-[72rem] px-4 py-6 sm:px-8">
    <RecipeEditor work={work} mainVersion={mainVersion} language="en" actingSubject={actingSubject} workHref="/w/lemon-muffins"
      locale={locale} messages={messages[locale]} main={fake.main}
      initial={{ recipe: start, notes: notes ?? noNotes, details: { head: id(700), values: detailsValues } }} />
  </div>;
}

const meta = { title: 'Recipe editor/Editor', component: Page, args: { locale: 'en', start: startRecipe },
  parameters: { route: { pathname: '/en/w/lemon-muffins/edit/recipe' } } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

const t = copyOf('en');
const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const changes = () => current.calls.filter(call => call.name === 'changes');
const ops = (call: { body?: unknown }) => (call.body as { operations: { op: string }[] }).operations;
const lines = (root: HTMLElement) => [...root.querySelectorAll('[data-line]')].map(item => item.textContent ?? '');

/** A cook types an ingredient the way they would write it; the parts show as read, and Enter adds it and keeps the field. */
export const TypesAnIngredientLine: Story = {
  args: { start: emptyStart },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const add = canvas.getByRole('form', { name: 'Add an ingredient' });
    const field = within(add).getByRole('textbox', { name: 'Ingredient line' });
    await userEvent.type(field, '1½ cups all-purpose flour, sifted');
    const parts = within(add).getByLabelText('Read as');
    await expect(parts).toHaveTextContent('Amount:1½');
    await expect(parts).toHaveTextContent('Unit:cups');
    await expect(parts).toHaveTextContent('Ingredient:all-purpose flour');
    await expect(parts).toHaveTextContent('Note:sifted');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(lines(canvasElement)).toEqual(['1½ cups all-purpose flour, sifted']));
    // The first write created the recipe's Composition, then inserted the line with its exact amount.
    await expect(current.calls.map(call => call.name)).toEqual(['create', 'changes']);
    await expect(changes()[0]!.body).toMatchObject({ operations: [{ op: 'insert', role: 'ingredient', qualifier: {
      amountLexical: '1½', amount: { numerator: 3, denominator: 2 }, unitText: 'cups', parseStatus: 'parsed' } }] });
    await expect(field).toHaveValue('');
    await expect(field).toHaveFocus();
    noOverflow();
  },
};

/** The same name in two sections stays two lines; a step links to one of them by its section. */
export const SectionsAndALinkedStep: Story = {
  args: { start: emptyStart },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const addLine = async (form: HTMLElement, text: string) => {
      await userEvent.type(within(form).getByRole('textbox', { name: 'Ingredient line' }), `${text}{Enter}`);
    };
    await addLine(canvas.getByRole('form', { name: 'Add an ingredient' }), '200 g butter');
    await userEvent.type(within(canvas.getByRole('form', { name: 'Add a section' })).getByRole('textbox', { name: 'Section name' }), 'Icing');
    await userEvent.click(canvas.getByRole('button', { name: 'Add section' }));
    await waitFor(() => expect(canvas.getByRole('group', { name: 'Section Icing' })).toBeVisible());
    await addLine(canvas.getByRole('form', { name: 'Add an ingredient to Icing' }), '100 g butter');
    await waitFor(() => expect(lines(canvasElement)).toEqual(['200 g butter', '100 g butter']));
    const step = canvas.getByRole('form', { name: 'Add a step' });
    await userEvent.type(within(step).getByRole('textbox'), 'Beat the icing butter until pale.');
    await userEvent.click(within(step).getByRole('button', { name: 'Link ingredients' }));
    const icing = within(within(step).getByRole('group', { name: 'Ingredients used' })).getByRole('group', { name: /Icing/ });
    await userEvent.click(within(icing).getByRole('checkbox', { name: '100 g butter' }));
    await userEvent.click(within(step).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-step]')).toHaveLength(1));
    const written = current.world().recipe;
    const icingButter = written.nodes.find(node => node.role === 'ingredient' && node.parent !== written.structure && node.qualifier.originalText.value === '100 g butter');
    const linked = written.nodes.find(node => node.role === 'step');
    await expect(linked && linked.role === 'step' && linked.qualifier.usesIngredient).toEqual([icingButter?.occurrence]);
  },
};

/** Editing a line changes its text in place: its place and the step that uses it are untouched. */
export const EditsALineInPlace: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit 200 g butter, softened' }));
    const form = canvas.getByRole('form', { name: 'Edit 200 g butter, softened' });
    const amount = within(form).getByRole('textbox', { name: 'Amount' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '250');
    // Typing a part rewrites the whole line.
    await expect(within(form).getByRole('textbox', { name: 'Ingredient line' })).toHaveValue('250 g butter, softened');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(canvas.getByText('250 g butter, softened', { selector: '[data-line] span' })).toBeVisible());
    await expect(changes()).toHaveLength(1);
    await expect(ops(changes()[0]!).map(op => op.op)).toEqual(['update']);
    const step = current.world().recipe.nodes.find(node => node.role === 'step');
    await expect(step && step.role === 'step' && step.qualifier.usesIngredient).toEqual([id(21)]);
  },
};

/** Removing an ingredient a step uses edits it out of the step in the same change. */
export const RemovingALinkedLine: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove 200 g butter, softened' }));
    await waitFor(() => expect(lines(canvasElement)).toEqual(['1½ cups flour, sifted', '100 g butter']));
    await expect(ops(changes()[0]!).map(op => op.op)).toEqual(['update', 'remove']);
    const step = current.world().recipe.nodes.find(node => node.role === 'step');
    await expect(step && step.role === 'step' && step.qualifier.usesIngredient).toEqual([]);
  },
};

/** Another window changed the recipe first: the refused edit is worked out again over what Main holds now. */
export const StaleEditFromASecondTab: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    let once = true;
    current.interference.before = call => {
      if (call.name === 'changes' && once) {
        once = false;
        current.elsewhere(state => ({ ...state, nodes: [...state.nodes, { occurrence: id(50), parent: id(12), role: 'ingredient',
          qualifier: qualifierOf(parseLine('2 tbsp lemon juice'), 'en') }] }));
      }
    };
    await userEvent.click(canvas.getByRole('button', { name: 'Move 1½ cups flour, sifted up' }));
    await waitFor(() => expect(changes()).toHaveLength(2));
    await expect(changes()[0]!.body).toMatchObject({ expectedHead: id(900) });
    await expect(changes()[1]!.body).not.toMatchObject({ expectedHead: id(900) });
    await waitFor(() => expect(lines(canvasElement)).toEqual(['1½ cups flour, sifted', '200 g butter, softened', '100 g butter', '2 tbsp lemon juice']));
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

/** An edit to something another window removed is not written; the cook is told, and the page shows the latest. */
export const EditOfARemovedLine: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit 100 g butter' }));
    const form = canvas.getByRole('form', { name: 'Edit 100 g butter' });
    current.interference.before = call => {
      if (call.name === 'changes') current.elsewhere(state => ({ ...state, nodes: state.nodes.filter(node => node.occurrence !== id(23)) }));
    };
    await userEvent.type(within(form).getByRole('textbox', { name: 'Note' }), 'chilled');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(t.failGone));
    await expect(changes()).toHaveLength(1);
    await expect(lines(canvasElement)).not.toContain('100 g butter');
  },
};

/** Yield and times are written when a field is left, and only what changed is sent. */
export const YieldAndTimes: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const cook = canvas.getByRole('textbox', { name: 'Cook time' });
    await userEvent.type(cook, '45');
    await userEvent.tab();
    await waitFor(() => expect(current.calls.filter(call => call.name === 'timings')).toHaveLength(1));
    await expect(current.calls.find(call => call.name === 'timings')!.body).toMatchObject({ cooking: { value: { numerator: 45, denominator: 1 }, unitText: 'min' } });
    await expect(current.calls.find(call => call.name === 'timings')!.body).not.toHaveProperty('preparation');
    const servings = canvas.getByRole('textbox', { name: 'Servings' });
    await userEvent.clear(servings);
    await userEvent.type(servings, 'x');
    await userEvent.tab();
    await expect(canvas.getByText(t.amountInvalid)).toBeVisible();
    await expect(current.calls.filter(call => call.name === 'measures')).toHaveLength(0);
  },
};

/** Publishing waits for what a reader needs; with notes written it saves them, publishes and selects them. */
export const PublishesWithNotes: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const publish = canvas.getByRole('button', { name: 'Publish' });
    await expect(publish).toBeDisabled();
    await expect(canvas.getByText(/To publish: write a note/)).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Notes' }), 'Best the day after baking.');
    await waitFor(() => expect(publish).toBeEnabled());
    await userEvent.click(publish);
    await waitFor(() => expect(canvas.getByText('Published. Everyone can read this recipe.')).toBeVisible());
    await expect(current.calls.map(call => call.name).filter(name => ['notes-create', 'publish', 'select'].includes(name)))
      .toEqual(['notes-create', 'publish', 'select']);
    await expect(canvas.getByRole('link', { name: /View recipe/ })).toHaveAttribute('href', expect.stringContaining('/w/lemon-muffins'));
  },
};

/** On a phone the editor and its preview are two views, and nothing runs off the screen. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'false');
    noOverflow();
    await userEvent.click(canvas.getByRole('button', { name: 'Preview' }));
    await expect(canvas.getByRole('article')).toBeVisible();
    noOverflow();
  },
};

const sample = (locale: UiLocale): Story => ({
  args: { locale },
  globals: { locale },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const words = copyOf(locale);
    await expect(canvas.getByRole('heading', { name: words.ingredientsHeading })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: words.methodHeading })).toBeVisible();
    noOverflow();
  },
});
export const English = sample('en');
export const TraditionalChinese = sample('zh-Hant');
export const SimplifiedChinese = sample('zh-Hans');
export const Japanese = sample('ja');
export const Korean = sample('ko');
export const German = sample('de');
export const French = sample('fr');
export const Spanish = sample('es');
