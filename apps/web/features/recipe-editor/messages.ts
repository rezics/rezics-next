import { asValue, insert, materializeData, number, plural } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for the recipe editor. What a cook writes (titles, lines, steps) is never here,
// and neither is any word Main renders; a refusal's reason is Main's own text under a headline from this catalog.
const en = {
  pageTitle: 'Edit recipe', backToRecipe: 'Back to the recipe', viewRecipe: 'View recipe',
  editRecipe: 'Edit recipe',
  editorView: 'Editor view', viewEdit: 'Edit', viewPreview: 'Preview',
  saving: 'Saving…', allSaved: 'All changes saved', stateDraft: 'Draft', statePublished: 'Published',

  detailsHeading: 'About this recipe',
  title: 'Title', description: 'Description',
  descriptionHelp: 'A line or two shown under the title.',
  notes: 'Notes', notesHelp: 'Where it comes from, tips and variations. Notes are what gets published with the recipe.',
  language: insert('Written in {{language}}', { language: String }),

  measuresHeading: 'Yield and time',
  makes: 'Makes', makesUnit: 'What it makes', makesUnitHelp: 'muffins, loaves, a 9-inch pie…',
  servings: 'Servings', servingsWord: 'servings',
  prepTime: 'Prep time', cookTime: 'Cook time', totalTime: 'Total time', minutesUnit: 'min', minutesName: 'minutes',
  timeOther: insert('Set as {{value}}. Typing here replaces it with minutes.', { value: String }),
  amountInvalid: 'Use a number such as 4, 1½ or 0.5.',
  minutesInvalid: 'Use whole minutes, such as 45.',

  ingredientsHeading: 'Ingredients',
  unsectioned: 'Ingredients',
  sectionName: 'Section name', sectionPlaceholder: 'For the sauce',
  addSection: 'Add a section', addSectionHelp: 'Group ingredients, such as the cake and the icing.',
  addSectionAction: 'Add section',
  removeSection: insert('Remove section {{name}}', { name: String }),
  removeSectionConfirm: insert('Remove “{{name}}” and the ingredients in it? Steps using them keep their text.', { name: String }),
  confirmRemove: 'Remove', keep: 'Keep',
  moveUp: insert('Move {{name}} up', { name: String }), moveDown: insert('Move {{name}} down', { name: String }),
  addIngredient: 'Add an ingredient', addIngredientTo: insert('Add an ingredient to {{section}}', { section: String }),
  ingredientPlaceholder: '1½ cups flour, sifted',
  ingredientHelp: 'Type the line as you would write it: amount, unit, name, then a note after a comma.',
  quantity: 'Amount', unit: 'Unit', name: 'Ingredient', note: 'Note',
  unitSuggestions: 'Common units',
  addAction: 'Add', saveAction: 'Save', cancel: 'Cancel', edit: insert('Edit {{name}}', { name: String }),
  remove: insert('Remove {{name}}', { name: String }),
  moveToSection: 'Section', noSection: 'No section',
  emptyIngredients: 'No ingredients yet. Add the first one below.',
  emptySection: 'Nothing in this section yet.',
  ingredientLine: 'Ingredient line',
  sectionLabel: insert('Section {{name}}', { name: String }),

  methodHeading: 'Method',
  addStep: 'Add a step', stepPlaceholder: 'What to do, in a sentence or two', stepHelp: 'Press Ctrl+Enter to add.',
  stepNumber: insert('Step {{number}}', { number: String }),
  stepText: insert('Text of step {{number}}', { number: String }),
  emptySteps: 'No steps yet. Add the first one below.',
  usesIngredients: 'Ingredients used', usesNone: 'None linked',
  usesCount: plural({ one: insert('{{count}} ingredient linked'), other: insert('{{count}} ingredients linked') }, { count: asValue(number()) }),
  usesChoose: 'Link ingredients', usesHide: 'Done',
  usesEmpty: 'Add ingredients to link them to steps.',
  usesInSection: insert('In {{section}}', { section: String }),
  stepSection: insert('In {{section}}', { section: String }),

  previewHeading: 'Preview', previewHelp: 'How the recipe reads on its page.',
  previewEmpty: 'Nothing to show yet.',

  publish: 'Publish', publishUpdate: 'Publish changes', publishing: 'Publishing…',
  publishedNotice: 'Published. Everyone can read this recipe.',
  publishNeeds: 'To publish:',
  needTitle: 'give it a title', needIngredient: 'add an ingredient', needStep: 'add a step', needNotes: 'write a note',

  loadingRest: 'Loading the rest of this recipe…',
  loadingRestCount: insert('{{count}} parts loaded', { count: String }),
  loadingRestFailed: 'The rest of this recipe couldn’t be loaded, so it can’t be edited yet.',
  recipeTooLong: 'This recipe is too long to edit here.',
  recipeChangedWhileLoading: 'This recipe changed while it was loading. Loading it again.',

  retry: 'Try again', dismiss: 'Dismiss', reload: 'Show the latest',
  failSignIn: 'Sign in again to keep editing.',
  failDenied: 'You can’t change this recipe.',
  failInvalid: 'That change wasn’t accepted.',
  failUnavailable: 'The change couldn’t be saved. Try again.',
  failPending: 'Still being applied. Try again in a moment; it won’t be applied twice.',
  failMoved: 'This recipe changed in another window and your change couldn’t be applied there. It shows the latest now.',
  failGone: 'That was removed in another window, so your change wasn’t applied.',
  failTooMany: 'Too many things depend on this to change it in one go.',
  failYield: 'A recipe keeps its yield once set. Change it instead of clearing it.',
  failEmptyNotes: 'Notes can’t be blank once written. Edit them instead.',
  mainSays: 'Reason',

  notRecipeTitle: 'This isn’t a recipe',
  notRecipeBody: 'The recipe editor opens for recipes only.',
  unavailableTitle: 'The recipe couldn’t be loaded',
  unavailableBody: 'REZICS couldn’t read this recipe. Try again in a moment.',
};

export const englishMessages = en;
export type RecipeEditorMessages = typeof en;

export const messages = defineMessages({
  en,
  'zh-Hant': withEnglish(en, zhHant),
  'zh-Hans': withEnglish(en, zhHans),
  ja: withEnglish(en, ja),
  ko: withEnglish(en, ko),
  de: withEnglish(en, de),
  fr: withEnglish(en, fr),
  es: withEnglish(en, es),
});

/** The interface strings of one locale, ready to call (`t.moveUp(name)`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type Copy = ReturnType<typeof copyOf>;
