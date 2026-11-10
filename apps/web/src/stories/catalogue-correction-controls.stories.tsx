import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import facts from './subject-facts.stories';
import identifiers from './catalogue-identifiers-profile.stories';
import recipe from './recipe-editor.stories';
import album from './catalogue-album-profile.stories';
import character from './catalogue-character-profile.stories';
import { createObserver, type ObserveCreate } from './catalogue-language-row-recovery';
import { identifiersCitation, identifiersProfileFixture } from '../kernel/fake/catalogue-identifiers-profile';
import definitions from '../kernel/recorded/definitions-release.json';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';

type Flow = 'facts' | 'identifiers' | 'recipe-correction' | 'album' | 'character' | 'recipe';
function Example({ flow, onCreate = () => {} }: { flow: Flow; onCreate?: ObserveCreate }) {
  switch (flow) {
    case 'facts':
      return <facts.component />;
    case 'identifiers':
      return <identifiers.component />;
    case 'recipe-correction':
      return <recipe.component correction />;
    case 'album':
      return <album.component onCreate={onCreate} />;
    case 'character':
      return <character.component onCreate={onCreate} />;
    case 'recipe':
      return <recipe.component onCreate={onCreate} />;
  }
}

const meta = {
  title: 'Catalogue/Correction controls and language recovery',
  id: 'pages-catalogue-correction-controls-and-language-recovery',
  component: Example,
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
          'The existing real editors and their existing request fixtures. Geometry, keyboard recovery and submitted values are asserted at phone and desktop widths; locale and theme use the ordinary globals. Native and browser execution remain integration obligations.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function contained(control: HTMLElement, region: HTMLElement) {
  const rect = control.getBoundingClientRect();
  const bounds = region.getBoundingClientRect();
  await expect(control).toBeVisible();
  await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
  await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
}

async function separated(first: HTMLElement, second: HTMLElement) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  const gap = Math.max(b.top - a.bottom, a.top - b.bottom, b.left - a.right, a.left - b.right);
  await expect(gap).toBeGreaterThanOrEqual(8 - 1);
}

function correction(flow: 'facts' | 'identifiers', viewport: 'phone390' | 'desktop1280'): Story {
  return {
    args: { flow },
    globals: {},
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const property = flow === 'facts' ? 'schema:inLanguage' : 'schema:sameAs';
      const release = flow === 'facts' ? definitions.release : identifiersProfileFixture().release;
      const label = pickText(release.properties[property]!.labels, getLocale()).text;
      const region = await canvas.findByRole('region', { name: label });
      const field = within(region);
      const select = field.getByRole('combobox', { name: m.facts_choose_value() });
      const edit = field.getByRole('button', { name: m.facts_edit_field() });
      const add = field.getByRole('button', { name: m.facts_add_value() });
      await contained(select, region);
      await expect(select.getBoundingClientRect().width).toBeGreaterThanOrEqual(160);
      await expect(select.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      for (const action of [edit, add]) {
        await contained(action, region);
        await expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await separated(select, action);
      }
      await separated(edit, add);
      await contained(canvas.getByRole('button', { name: m.facts_submit() }), canvasElement);
      await userEvent.selectOptions(select, field.getByRole('option', { name: m.facts_selected_value({ number: 1 }) }));
      select.focus();
      await userEvent.tab();
      await expect(edit).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      await expect(field.getAllByRole('textbox', { name: m.correction_value() })[0]!).toHaveValue(
        flow === 'facts' ? 'en' : identifiersCitation,
      );
    },
  };
}

function recipeCorrection(viewport: 'phone390' | 'desktop1280'): Story {
  return {
    args: { flow: 'recipe-correction' },
    globals: {},
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      for (const property of ['schema:recipeIngredient', 'schema:recipeYield'] as const) {
        const label = pickText(definitions.release.properties[property].labels, getLocale()).text;
        const heading = await canvas.findByRole('heading', { name: label });
        const region = heading.closest('section')!;
        const field = within(region);
        const value = field.getByText(property === 'schema:recipeIngredient' ? '200 g lentils' : '2', { exact: true });
        const action = field.getByRole('button', { name: m.recipe_correct() });
        await contained(value, region);
        await contained(action, region);
        await separated(value, action);
        action.focus();
        await userEvent.keyboard('{Enter}');
        await expect(action).toBeDisabled();
        const replacement = canvas.getAllByRole('heading', { name: label }).at(-1)!.closest('section')!;
        const control = within(replacement).getByRole('textbox', {
          name: property === 'schema:recipeIngredient' ? m.correction_value() : m.correction_amount(),
        });
        await expect(control).toHaveValue(property === 'schema:recipeIngredient' ? '200 g lentils' : '+2');
      }
    },
  };
}

function languageRecovery(flow: 'album' | 'character' | 'recipe', viewport: 'phone390' | 'desktop1280'): Story {
  return {
    args: { flow, onCreate: createObserver() },
    globals: {},
    play: async ({ canvasElement, args }) => {
      const canvas = within(canvasElement);
      const observed = args.onCreate as ReturnType<typeof createObserver>;
      const termsElement = await canvas.findByRole('group', { name: m.catalogue_create_terms() });
      const terms = within(termsElement);
      const name = terms.getByRole('textbox', { name: m.catalogue_create_label() });
      const language = terms.getByRole('textbox', { name: m.catalogue_create_language() });
      const primaryName = { album: 'Harbour sessions', character: 'A new traveler', recipe: 'Lentil soup' }[flow];
      await userEvent.clear(language);
      await userEvent.type(language, 'en');
      await userEvent.type(name, primaryName);
      await expect(terms.queryByRole('button', { name: m.catalogue_create_remove_language() })).toBeNull();
      const add = terms.getByRole('button', { name: m.catalogue_create_add_language() });
      await userEvent.click(add);
      await userEvent.click(add);
      const [unwanted, retained] = terms.getAllByRole('group', { name: m.catalogue_create_language() });
      const retainedFields = within(retained!);
      const retainedLanguage = retainedFields.getByRole('textbox', { name: m.catalogue_create_language() });
      const retainedName = retainedFields.getByRole('textbox', { name: m.catalogue_create_label() });
      await userEvent.type(retainedLanguage, 'ja');
      await userEvent.type(retainedName, '旅人');
      const description = retainedFields.getByRole('textbox', { name: m.catalogue_create_description() });
      await userEvent.type(description, 'Translation description');
      const aliases = retainedFields.getByRole('textbox', { name: m.catalogue_create_aliases() });
      await userEvent.type(aliases, 'First alias\nSecond alias');

      // Enter submits the real form. A blank added row remains invalid until explicitly removed.
      name.focus();
      await userEvent.keyboard('{Enter}');
      await canvas.findAllByRole('alert');
      await expect(observed).not.toHaveBeenCalled();
      const remove = within(unwanted!).getByRole('button', { name: m.catalogue_create_remove_language() });
      await contained(remove, termsElement);
      await expect(remove.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      remove.focus();
      await userEvent.keyboard('{Enter}');
      await expect(unwanted).not.toBeInTheDocument();
      await expect(retainedLanguage).toHaveFocus();
      await expect(retainedName).toHaveValue('旅人');
      await expect(description).toHaveValue('Translation description');
      await expect(aliases).toHaveValue('First alias\nSecond alias');
      await expect(name).toHaveValue(primaryName);

      // Removing the final blank row returns focus to Add, keeping the earlier translation untouched.
      await userEvent.click(add);
      const lastRemove = terms.getAllByRole('button', { name: m.catalogue_create_remove_language() }).at(-1)!;
      lastRemove.focus();
      await userEvent.keyboard(' ');
      await expect(add).toHaveFocus();
      await expect(retainedName).toBeInTheDocument();
      await userEvent.type(description, ' retained');
      await expect(observed).not.toHaveBeenCalled();

      // The primary name is still required after optional rows have been removed.
      await userEvent.clear(name);
      name.focus();
      await userEvent.keyboard('{Enter}');
      await canvas.findAllByRole('alert');
      await expect(observed).not.toHaveBeenCalled();
      await userEvent.type(name, primaryName);
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
      const writes = observed.mock.calls[0]![0].filter(
        (call) => call.method === 'POST' && call.path === '/v1/subjects',
      );
      await expect(writes).toHaveLength(1);
      await expect(writes[0]!.body).toEqual({
        type: { album: 'schema:MusicAlbum', character: 'wd:Q95074', recipe: 'schema:Recipe' }[flow],
        labels: { en: primaryName, ja: '旅人' },
        descriptions: { ja: 'Translation description retained' },
        aliases: { ja: ['First alias', 'Second alias'] },
        statements: {},
      });
      await expect(writes[0]!.key).toBeTruthy();
      await expect(
        await canvas.findByText(
          {
            album: m.catalogue_create_created(),
            character: m.character_created(),
            recipe: m.recipe_created(),
          }[flow],
        ),
      ).toBeVisible();
    },
  };
}

export const FactsPhone: Story = { ...correction('facts', 'phone390') };
export const FactsDesktop: Story = { ...correction('facts', 'desktop1280') };
export const IdentifiersPhone: Story = { ...correction('identifiers', 'phone390') };
export const IdentifiersDesktop: Story = { ...correction('identifiers', 'desktop1280') };
export const RecipeCorrectionPhone: Story = { ...recipeCorrection('phone390') };
export const RecipeCorrectionDesktop: Story = { ...recipeCorrection('desktop1280') };
export const AlbumLanguagePhone: Story = { ...languageRecovery('album', 'phone390') };
export const AlbumLanguageDesktop: Story = { ...languageRecovery('album', 'desktop1280') };
export const CharacterLanguagePhone: Story = { ...languageRecovery('character', 'phone390') };
export const CharacterLanguageDesktop: Story = { ...languageRecovery('character', 'desktop1280') };
export const RecipeLanguagePhone: Story = { ...languageRecovery('recipe', 'phone390') };
export const RecipeLanguageDesktop: Story = { ...languageRecovery('recipe', 'desktop1280') };
