import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useMemo } from 'react';
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
import {
  createObserver,
  recoverLanguageRow,
  retryLanguageRecovery,
  type ObserveCreate,
} from './catalogue-language-row-recovery';

function RecipeStory({
  scenario = 'ready',
  correction = false,
  signedOut = false,
  onCreate,
  onFixture,
}: {
  scenario?: RecipeScenario;
  correction?: boolean;
  signedOut?: boolean;
  onCreate?: ObserveCreate;
  onFixture?: (fixture: ReturnType<typeof recipeFixture>) => void;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => recipeFixture(correction ? 'ready' : scenario, locale), [scenario, locale, correction]);
  useEffect(() => onFixture?.(fixture), [fixture, onFixture]);
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
        : {
            ...fixture.transport,
            create: async (command: Parameters<typeof fixture.transport.create>[0]) => {
              const result = await fixture.transport.create(command);
              onCreate?.(structuredClone(fixture.calls));
              return result;
            },
          },
    [fixture, scenario, correction, onCreate],
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
const observeRecipe = () => fn<(fixture: ReturnType<typeof recipeFixture>) => void>();
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
async function cite(scope: ReturnType<typeof within>, url: string) {
  await userEvent.click(scope.getByRole('button', { name: m.correction_add_reference() }));
  const group = [...scope.getByRole('heading').closest('section')!.querySelectorAll('fieldset')]
    .filter((node) => node.querySelector('legend')?.textContent?.includes(m.correction_references()))
    .at(-1)!;
  const region = within(group as HTMLElement);
  await userEvent.selectOptions(region.getByRole('combobox', { name: m.correction_add_part() }), 'schema:url');
  await userEvent.click(region.getByRole('button', { name: m.correction_add() }));
  await userEvent.type(region.getByRole('textbox', { name: m.correction_url() }), url);
}
async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Lentil soup');
  const ingredient = await addField(canvasElement, 'schema:recipeIngredient');
  await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_value() }), '200 g lentils');
  await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_language() }), 'en');
  await cite(ingredient, 'https://cook.example/my-lentil-soup');
  const body = within(canvasElement.ownerDocument.body);
  for (const [property, title] of [
    ['wdt:P186', 'Lentils'],
    ['schema:suitableForDiet', 'Vegetarian diet'],
  ] as const) {
    const target = await addField(canvasElement, property);
    await userEvent.type(target.getByRole('combobox', { name: fieldName(property) }), title);
    await userEvent.click(await body.findByRole('option', { name: new RegExp(title) }));
    await cite(target, 'https://cook.example/my-lentil-soup');
  }
  const yieldField = await addField(canvasElement, 'schema:recipeYield');
  await userEvent.type(yieldField.getByRole('textbox', { name: m.correction_amount() }), '+2');
  await userEvent.selectOptions(yieldField.getByRole('combobox', { name: m.correction_unit() }), '1');
  await cite(yieldField, 'https://cook.example/my-lentil-soup');
  const duration = await addField(canvasElement, 'schema:cookTime');
  await userEvent.type(duration.getByRole('textbox', { name: m.correction_amount() }), '+25');
  await userEvent.selectOptions(
    duration.getByRole('combobox', { name: m.correction_unit() }),
    'http://www.wikidata.org/entity/Q7727',
  );
  await cite(duration, 'https://cook.example/my-lentil-soup');
  const method = await addField(canvasElement, 'schema:recipeInstructions');
  await userEvent.click(method.getByRole('button', { name: m.recipe_replace_method() }));
  await userEvent.type(method.getByRole('textbox', { name: m.catalogue_create_language() }), 'en');
  await userEvent.type(method.getByRole('textbox', { name: m.subject_source_licence() }), 'CC-BY-4.0');
  await userEvent.type(
    await method.findByRole('textbox', { name: fieldName('schema:recipeInstructions') }),
    'Simmer my lentils gently, then serve the soup.',
  );
  await cite(method, 'https://cook.example/my-lentil-soup');
  await userEvent.click(method.getByRole('checkbox', { name: m.recipe_original() }));
  return canvas;
}
async function create(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.recipe_review() }));
  await userEvent.click(canvas.getByRole('button', { name: m.recipe_title() }));
  return canvas;
}
export const Ready: Story = {};
export const LanguageRowRecovery: Story = {
  args: { scenario: 'uncertain', onCreate: createObserver() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Lentil soup');
    for (const text of ['200 g lentils', '400 ml water']) {
      const ingredient = await addField(canvasElement, 'schema:recipeIngredient');
      await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_value() }), text);
      await userEvent.type(ingredient.getByRole('textbox', { name: m.correction_language() }), 'en');
      await cite(ingredient, 'https://cook.example/my-lentil-soup');
    }
    const material = await addField(canvasElement, 'wdt:P186');
    await userEvent.type(material.getByRole('combobox', { name: fieldName('wdt:P186') }), 'Lentils');
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /Lentils/ }));
    await cite(material, 'https://cook.example/my-lentil-soup');
    const observed = args.onCreate as ReturnType<typeof createObserver>;
    const terms = await recoverLanguageRow(
      canvasElement,
      m.recipe_review(),
      observed,
      'Lentil soup',
      'レンズ豆のスープ',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.recipe_review() }));
    const example = recipeExample();
    await retryLanguageRecovery(canvasElement, m.recipe_title(), m.correction_retry(), observed, {
      type: 'schema:Recipe',
      ...terms,
      statements: {
        'schema:recipeIngredient': [
          example.statements['schema:recipeIngredient']![0],
          {
            ...example.statements['schema:recipeIngredient']![0],
            value: { type: 'value', content: { language: 'en', text: '400 ml water' } },
          },
        ],
        'wdt:P186': example.statements['wdt:P186'],
      },
    });
    await expect(await canvas.findByText(m.recipe_created())).toBeVisible();
  },
};
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
  args: { correction: true, onFixture: observeRecipe() },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const observed = args.onFixture as ReturnType<typeof observeRecipe>;
    await waitFor(() => expect(observed).toHaveBeenCalled());
    const fixture = observed.mock.calls.at(-1)![0];
    // Assert rendered targets and containment, independently of their implementation classes.
    const phoneControl = async (control: HTMLElement, region: HTMLElement) => {
      const rect = control.getBoundingClientRect();
      const bounds = region.getBoundingClientRect();
      await expect(control).toBeVisible();
      await expect(rect.height).toBeGreaterThanOrEqual(44);
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    };
    const heading = await canvas.findByRole('heading', { name: fieldName('schema:cookTime') });
    const current = within(heading.closest('section')!);
    const correct = current.getByRole('button', { name: m.recipe_correct() });
    await phoneControl(correct, canvasElement);
    await userEvent.click(correct);
    const replacement = canvas.getAllByRole('heading', { name: fieldName('schema:cookTime') }).at(-1)!;
    const region = replacement.closest('section')!;
    const field = within(region);
    const amount = field.getByRole('textbox', { name: m.correction_amount() });
    await expect(amount).toHaveValue('+25');
    await expect(field.getByRole('combobox', { name: m.correction_unit() })).toHaveValue(
      'http://www.wikidata.org/entity/Q7727',
    );
    await userEvent.clear(amount);
    await userEvent.type(amount, '+30');
    const citation = field.getByRole('textbox', { name: m.correction_url() });
    await userEvent.clear(citation);
    await userEvent.type(citation, 'https://cook.example/revised-time');
    const remove = field.getByRole('button', { name: m.recipe_remove_field() });
    const reviewDraft = field.getByRole('button', { name: m.recipe_review() });
    const submit = field.getByRole('button', { name: m.correction_submit() });
    for (const control of [amount, citation, remove, reviewDraft, submit]) await phoneControl(control, region);
    await userEvent.click(reviewDraft);

    fixture.setScenario('conflict');
    await userEvent.click(submit);
    await expect(await field.findByText(m.correction_stale())).toBeVisible();
    const reviewNew = field.getByRole('button', { name: m.catalogue_create_review_new() });
    const staleRetry = field.getByRole('button', { name: m.correction_retry() });
    for (const control of [reviewNew, staleRetry]) await phoneControl(control, region);
    const a = reviewNew.getBoundingClientRect();
    const b = staleRetry.getBoundingClientRect();
    await expect(Math.max(b.top - a.bottom, b.left - a.right)).toBeGreaterThanOrEqual(8);
    await expect(staleRetry).toBeDisabled();
    await expect(amount).toBeDisabled();
    await expect(remove).toBeDisabled();
    reviewNew.focus();
    await userEvent.keyboard('{Enter}');
    await expect(amount).toBeEnabled();
    await expect(amount).toHaveValue('+30');
    await expect(citation).toHaveValue('https://cook.example/revised-time');

    fixture.setScenario('uncertain');
    await userEvent.click(field.getByRole('button', { name: m.correction_submit() }));
    await expect(await field.findByText(m.correction_unavailable())).toBeVisible();
    const retry = field.getByRole('button', { name: m.correction_retry() });
    await phoneControl(retry, region);
    await expect(amount).toBeDisabled();
    await expect(citation).toBeDisabled();
    await expect(remove).toBeDisabled();
    await userEvent.click(retry);
    await expect(await field.findByText(m.correction_proposed())).toBeVisible();
    const writes = fixture.calls.filter(
      (call) => call.method === 'POST' && call.path === `/v1/subjects/${recipeId}/candidates`,
    );
    await expect(writes).toHaveLength(3);
    const original = recipeExample().statements['schema:cookTime']![0]!;
    await expect(writes[1]!.body).toEqual({
      statement: {
        ...original,
        value: { type: 'value', content: { amount: '+30', unit: 'http://www.wikidata.org/entity/Q7727' } },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://cook.example/revised-time' },
              },
            ],
          },
        ],
      },
    });
    await expect(writes[1]!.key).toBeTruthy();
    await expect(writes[1]!.key).not.toBe(writes[0]!.key);
    await expect(writes[2]!.key).toBe(writes[1]!.key);
    await expect(writes[2]!.body).toEqual(writes[1]!.body);
    await expect(amount).toBeDisabled();
    await expect(correct).toBeDisabled();
    const review = field.getByRole('button', { name: m.correction_review() });
    await phoneControl(review, region);
    await userEvent.click(review);
    const candidates = within(await field.findByRole('region', { name: m.candidate_title() }));
    await expect(await candidates.findByRole('button', { name: m.candidate_accept() })).toBeEnabled();
    await expect(candidates.getByRole('combobox', { name: m.candidate_field() })).toHaveValue('schema:cookTime');
    await expect(candidates.getByRole('combobox', { name: m.candidate_field() })).toBeDisabled();
    const exact = [...fixture.candidates.keys()][0]!;
    await userEvent.click(candidates.getByRole('button', { name: m.candidate_accept() }));
    const confirmation = within(
      candidates.getByRole('region', {
        name: m.candidate_confirm_title({ action: m.candidate_accept() }),
      }),
    );
    await userEvent.click(confirmation.getByRole('button', { name: m.candidate_accept() }));
    await expect(await candidates.findByText(m.candidate_accepted())).toBeVisible();
    await expect(fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith(':accept'))).toEqual([
      expect.objectContaining({ path: `/v1/subjects/${recipeId}/candidates/${exact}:accept` }),
    ]);
    await expect(fixture.publicRead.subject.statements['schema:cookTime']![0]!.value).toEqual(original.value);

    // The authored replacement remains explicit, and removing its draft preserves the completed correction.
    const method = await addField(canvasElement, 'schema:recipeInstructions');
    const methodRegion = method
      .getByRole('heading', { name: fieldName('schema:recipeInstructions') })
      .closest('section')!;
    const replace = method.getByRole('button', { name: m.recipe_replace_method() });
    await phoneControl(replace, methodRegion);
    await userEvent.click(replace);
    const language = method.getByRole('textbox', { name: m.catalogue_create_language() });
    const licence = method.getByRole('textbox', { name: m.subject_source_licence() });
    for (const control of [language, licence]) await phoneControl(control, methodRegion);
    await userEvent.type(language, 'en');
    await userEvent.type(licence, 'CC-BY-4.0');
    await userEvent.type(
      await method.findByRole('textbox', { name: fieldName('schema:recipeInstructions') }),
      'Simmer my lentils gently, then serve the soup.',
    );
    await cite(method, 'https://cook.example/my-lentil-soup');
    await expect(method.getByRole('button', { name: m.correction_submit() })).toBeDisabled();
    await userEvent.click(method.getByRole('checkbox', { name: m.recipe_original() }));
    await userEvent.click(method.getByRole('button', { name: m.recipe_review() }));
    await expect(method.getByRole('button', { name: m.correction_submit() })).toBeEnabled();
    await userEvent.click(method.getByRole('button', { name: m.recipe_remove_field() }));
    await expect(methodRegion).not.toBeInTheDocument();
    await expect(field.getByText(m.correction_proposed())).toBeVisible();
  },
};

// Authored UNRUN: connected supplied-data examples, not native or geometry proof.
const familyValue = `200 g lentils — ${'carefully sorted whole lentils, 水と野菜 '.repeat(12)}`;
const familyCitation = `https://cook.example/original/${'long-supplied-citation-'.repeat(10)}?language=ja#method`;
function recipeFamilyFixture(locale: string) {
  const fixture = recipeFixture('ready', locale);
  // Explicit illustrative supplied labels, preserving each original localized name.
  for (const property of Object.values(fixture.release.properties)) {
    const original = pickText(property.labels, locale).text;
    property.labels[locale] = `${original} — ${'Complete supplied field name 材料と作り方 '.repeat(4)}`;
  }
  return fixture;
}
function RecipeFamilyStory({ onFixture, rtl = false }: { onFixture?: ObserveRecipeFamily | undefined; rtl?: boolean }) {
  const locale = getLocale();
  const creation = useMemo(() => recipeFamilyFixture(locale), [locale]);
  const correction = useMemo(() => recipeFamilyFixture(locale), [locale]);
  const transport = useMemo(
    () => ({
      ...correction.corrections,
      load: async () => {
        const item = recipeExample();
        item.statements['schema:recipeIngredient']![0]!.value = {
          type: 'value',
          content: { language: 'en', text: familyValue },
        };
        item.statements['schema:recipeIngredient']![0]!.references[0]!.parts[0]!.value = {
          type: 'value',
          content: familyCitation,
        };
        await correction.transport.create({ item, key: crypto.randomUUID() });
        return correction.corrections.load();
      },
    }),
    [correction],
  );
  useEffect(() => onFixture?.(correction), [correction, onFixture]);
  return (
    <PatternStory path="/catalogue/recipe" visitor="Signed In">
      <AppShell>
        <div dir={rtl ? 'rtl' : 'ltr'}>
          <div data-recipe-family="create">
            <RecipeEditor locale={locale} session="signed-in" transport={creation.transport} search={async () => []} />
          </div>
          <div data-recipe-family="correct">
            <RecipeEditor
              id={recipeId}
              locale={locale}
              session="signed-in"
              transport={transport}
              review={(property) => correction.review(property)}
              search={async () => []}
            />
          </div>
        </div>
      </AppShell>
    </PatternStory>
  );
}
type ObserveRecipeFamily = (fixture: ReturnType<typeof recipeFixture>) => void;
const familyDescription = {
  docs: {
    description: {
      story:
        'Authored UNRUN. Two independent actual editors with long supplied localized fields, exact values and citations. Browser, native and visual acceptance remains deferred.',
    },
  },
};
const exerciseRecipeFamily: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const createRegion = canvasElement.querySelector<HTMLElement>('[data-recipe-family="create"]')!;
  const correctRegion = canvasElement.querySelector<HTMLElement>('[data-recipe-family="correct"]')!;
  const creation = within(createRegion);
  const correction = within(correctRegion);
  const observer = args.onFixture as ReturnType<typeof observeRecipe>;
  await waitFor(() => expect(observer).toHaveBeenCalled());
  const fixture = observer.mock.calls.at(-1)![0];
  const property = 'schema:recipeIngredient';
  await expect(await correction.findByText(familyValue)).toBeVisible();
  const calls = fixture.calls.length;
  const ownAdd = creation.getByRole('combobox', { name: m.character_add_fact() });
  const otherAdd = correction.getByRole('combobox', { name: m.character_add_fact() });
  await expect(ownAdd.tagName).toBe('SELECT');
  await expect(otherAdd.tagName).toBe('SELECT');
  const ids = () => [...canvasElement.querySelectorAll('[id]')].map((node) => node.id);
  const assertAssociations = async () => {
    await expect(new Set(ids()).size).toBe(ids().length);
    for (const scope of [createRegion, correctRegion]) {
      for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
        const target = canvasElement.ownerDocument.getElementById(label.htmlFor);
        await expect(target).not.toBeNull();
        await expect(scope.contains(target)).toBe(true);
      }
    }
  };
  const target = async (node: HTMLElement, scope: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    const bounds = scope.getBoundingClientRect();
    await expect(node).toBeVisible();
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    // Native text inputs keep their own horizontal editing; their exact values are asserted below.
    if (!node.matches('input, select, textarea'))
      await expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
  };
  for (const [region, select] of [
    [createRegion, ownAdd],
    [correctRegion, otherAdd],
  ] as const) {
    const label = region.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`)!;
    await userEvent.click(label);
    await expect(select).toHaveFocus();
    await target(select, region);
  }
  await userEvent.selectOptions(ownAdd, property);
  await expect(otherAdd).toHaveValue('');
  await userEvent.tab();
  const add = creation.getByRole('button', { name: m.correction_add() });
  await expect(add).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  const ownField = createRegion.querySelector('section')!;
  const suppliedLabel = pickText(fixture.release.properties[property]!.labels, getLocale()).text;
  const heading = correction.getAllByRole('heading', { name: suppliedLabel, level: 2 })[0]!;
  const current = heading.closest('section')!;
  const frame = heading.parentElement!;
  await expect(frame.classList.contains('isolate')).toBe(true);
  await expect(frame.querySelector('[data-content-item-slot="preview"]')?.textContent).toContain(familyValue);
  await expect(frame.querySelector('[data-slot="list-row-link"]')).toBeNull();
  const correct = within(current).getByRole('button', { name: m.recipe_correct() });
  await target(correct, current);
  await userEvent.click(correct);
  const replacement = correction.getAllByRole('heading', { name: suppliedLabel, level: 2 }).at(-1)!.closest('section')!;
  const field = within(replacement);
  const value = field.getByRole('textbox', { name: m.correction_value() });
  await expect(value).toHaveValue(familyValue);
  await expect(within(ownField).getByRole('textbox', { name: m.correction_value() })).toHaveValue('');
  const citation = field.getByRole('textbox', { name: m.correction_url() });
  await userEvent.clear(citation);
  await userEvent.type(citation, familyCitation);
  const remove = field.getByRole('button', { name: m.recipe_remove_field() });
  const submit = field.getByRole('button', { name: m.correction_submit() });
  for (const node of [value, citation, remove, submit]) await target(node, replacement);
  const style = getComputedStyle(submit);
  await expect(style.outlineStyle !== 'none' || style.boxShadow !== 'none').toBe(true);
  await expect(fixture.calls).toHaveLength(calls); // Drafts, focus and association add zero reads.
  const publicLink = correction.getByRole('link', { name: m.candidate_view_public() });
  await expect(publicLink).toHaveAttribute('href', `/${getLocale()}/subjects/${recipeId}/lentil-soup`);
  await target(publicLink, correctRegion);
  await expect(publicLink.querySelector('button, input, select, a')).toBeNull();
  for (const region of [createRegion, correctRegion]) {
    const canvasBounds = region.getBoundingClientRect();
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
    for (const title of region.querySelectorAll('h2')) {
      await expect(title.textContent).toContain('Complete supplied field name');
      await expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
      await expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(canvasBounds.right + 1);
    }
  }
  // Both method panels retain their own explicit native label associations and rich-text role.
  for (const [region, select] of [
    [createRegion, ownAdd],
    [correctRegion, otherAdd],
  ] as const) {
    await userEvent.selectOptions(select, 'schema:recipeInstructions');
    await userEvent.click(within(region).getByRole('button', { name: m.correction_add() }));
    const method = [...region.querySelectorAll('section')].at(-1)!;
    const methodCanvas = within(method);
    await userEvent.click(methodCanvas.getByRole('button', { name: m.recipe_replace_method() }));
    for (const name of [m.catalogue_create_language(), m.subject_source_licence()]) {
      const input = methodCanvas.getByRole('textbox', { name });
      const label = method.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
      await expect(label.textContent).toBe(name);
      await userEvent.click(label);
      await expect(input).toHaveFocus();
      await target(input, method);
    }
    await target(methodCanvas.getByRole('checkbox', { name: m.recipe_original() }), method);
    await expect(method.querySelector('[contenteditable="true"][role="textbox"]')).not.toBeNull();
  }
  await assertAssociations();
};
export const IndependentFamilyPhone: Story = {
  args: { onFixture: observeRecipe() },
  render: (args) => <RecipeFamilyStory onFixture={args.onFixture} />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: familyDescription,
  play: exerciseRecipeFamily,
};
export const IndependentFamilyDesktop: Story = {
  ...IndependentFamilyPhone,
  args: { onFixture: observeRecipe() },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const IndependentFamilyRtl: Story = {
  ...IndependentFamilyPhone,
  args: { onFixture: observeRecipe() },
  render: (args) => <RecipeFamilyStory onFixture={args.onFixture} rtl />,
};
