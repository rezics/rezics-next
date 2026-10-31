import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { RecipeEditor } from '../features/catalogue/recipe-editor-view';
import {
  recipeExample,
  recipeFixture,
  recipeId,
  ingredientId,
  dietId,
  type RecipeScenario,
} from '../kernel/fake/recipe-editor';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import definitions from '../kernel/recorded/definitions-release.json';

function RecipeStory({
  scenario = 'ready',
  correction = false,
  signedOut = false,
}: {
  scenario?: RecipeScenario;
  correction?: boolean;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => recipeFixture(correction ? 'ready' : scenario, locale), [scenario, locale, correction]);
  const transport = useMemo(
    () =>
      correction
        ? {
            ...fixture.corrections,
            load: async () => {
              await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() });
              fixture.setScenario(scenario);
              return fixture.corrections.load();
            },
          }
        : fixture.transport,
    [fixture, scenario, correction],
  );
  return (
    <PatternStory path="/catalogue/recipe" visitor={signedOut ? 'Signed Out' : 'Signed In'}>
      <AppShell>
        <RecipeEditor
          locale={locale}
          {...(correction ? { id: recipeId } : {})}
          session={signedOut ? 'signed-out' : 'signed-in'}
          transport={transport}
          review={(property) => fixture.review(property)}
          search={async () => [
            { id: ingredientId, title: 'Lentils', types: ['wd:Q2095'], typeLabel: 'Food', cover: null },
            { id: dietId, title: 'Vegetarian diet', types: ['skos:Concept'], typeLabel: 'Concept', cover: null },
          ]}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Recipe editor',
  component: RecipeStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Released native Recipe fields, original authored documents and exact selected subjects. Declared examples use the generated request seam. Native acceptance and Web/Root visual review are pending. Use locale, viewport and theme globals.',
      },
    },
  },
} satisfies Meta<typeof RecipeStory>;
export default meta;
type Story = StoryObj<typeof meta>;
function fieldName(property: string) {
  const definition = definitions.release.properties[property as keyof typeof definitions.release.properties];
  return pickText(definition.labels, getLocale()).text;
}
async function addField(canvasElement: HTMLElement, property: string) {
  const canvas = within(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.character_add_fact() }), property);
  await userEvent.click(canvas.getByRole('button', { name: m.correction_add() }));
  const heading = canvas.getAllByRole('heading', { name: fieldName(property) }).at(-1)!;
  return within(heading.closest('section')!);
}
async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Lentil soup');
  const ingredient = await addField(canvasElement, 'schema:recipeIngredient');
  await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_value() }), '200 g lentils');
  await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_language() }), 'en');
  await userEvent.type(
    ingredient.getByRole('textbox', { name: m.relation_citation() }),
    'https://cook.example/my-lentil-soup',
  );
  const body = within(canvasElement.ownerDocument.body);
  for (const [property, title] of [
    ['wdt:P186', 'Lentils'],
    ['schema:suitableForDiet', 'Vegetarian diet'],
  ] as const) {
    const target = await addField(canvasElement, property);
    await userEvent.type(target.getByRole('combobox', { name: fieldName(property) }), title);
    await userEvent.click(await body.findByRole('option', { name: new RegExp(title) }));
    await userEvent.type(
      target.getByRole('textbox', { name: m.relation_citation() }),
      'https://cook.example/my-lentil-soup',
    );
  }
  const yieldField = await addField(canvasElement, 'schema:recipeYield');
  await userEvent.type(yieldField.getByRole('textbox', { name: m.correction_amount() }), '+2');
  await userEvent.selectOptions(yieldField.getByRole('combobox', { name: m.correction_unit() }), '1');
  await userEvent.type(
    yieldField.getByRole('textbox', { name: m.relation_citation() }),
    'https://cook.example/my-lentil-soup',
  );
  const duration = await addField(canvasElement, 'schema:cookTime');
  await userEvent.type(duration.getByRole('textbox', { name: m.correction_amount() }), '+25');
  await userEvent.selectOptions(
    duration.getByRole('combobox', { name: m.correction_unit() }),
    'http://www.wikidata.org/entity/Q7727',
  );
  await userEvent.type(
    duration.getByRole('textbox', { name: m.relation_citation() }),
    'https://cook.example/my-lentil-soup',
  );
  const method = await addField(canvasElement, 'schema:recipeInstructions');
  await userEvent.click(method.getByRole('button', { name: m.recipe_replace_method() }));
  await userEvent.type(method.getByRole('textbox', { name: m.catalogue_create_language() }), 'en');
  await userEvent.type(method.getByRole('textbox', { name: m.subject_source_licence() }), 'CC-BY-4.0');
  await userEvent.type(
    await method.findByRole('textbox', { name: fieldName('schema:recipeInstructions') }),
    'Simmer my lentils gently, then serve the soup.',
  );
  await userEvent.type(
    method.getByRole('textbox', { name: m.relation_citation() }),
    'https://cook.example/my-lentil-soup',
  );
  await userEvent.click(method.getByRole('checkbox', { name: m.recipe_original() }));
  return canvas;
}
async function create(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.recipe_title() }));
  return canvas;
}
export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Created: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.recipe_created())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toHaveAttribute(
      'href',
      expect.stringContaining(recipeId),
    );
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_denied())).toBeVisible();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_invalid())).toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_conflict())).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.correction_retry() }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};
export const Retry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_uncertain())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await expect(await canvas.findByText(m.recipe_created())).toBeVisible();
  },
};
export const ReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    await expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
  },
};
export const Correction: Story = { args: { correction: true } };
export const ExactCurrentValue: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { name: fieldName('schema:recipeIngredient') });
    const current = within(heading.closest('section')!);
    await expect(current.getByText('200 g lentils')).toBeVisible();
    await userEvent.click(current.getByRole('button', { name: m.recipe_correct() }));
    const replacement = canvas.getAllByRole('heading', { name: fieldName('schema:recipeIngredient') }).at(-1)!;
    const field = within(replacement.closest('section')!);
    await expect(field.getByRole('textbox', { name: m.correction_value() })).toHaveValue('200 g lentils');
    await expect(current.getByRole('button', { name: m.recipe_correct() })).toBeDisabled();
  },
};
export const Concealed: Story = { args: { correction: true, scenario: 'concealed' } };
export const Proposed: Story = {
  args: { correction: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { name: fieldName('schema:cookTime') });
    await userEvent.click(within(heading.closest('section')!).getByRole('button', { name: m.recipe_correct() }));
    const replacement = canvas.getAllByRole('heading', { name: fieldName('schema:cookTime') }).at(-1)!;
    const field = within(replacement.closest('section')!);
    const amount = field.getByRole('textbox', { name: m.correction_amount() });
    await userEvent.clear(amount);
    await userEvent.type(amount, '+30');
    await userEvent.click(field.getByRole('button', { name: m.correction_submit() }));
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
  },
};
