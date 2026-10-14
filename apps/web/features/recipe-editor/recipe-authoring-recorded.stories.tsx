import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import authoringFixture from '../../../../tests/qa/fixtures/outcomes/recipes/author-a-recipe.json';
import exchangeFixture from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { TypeRegistry } from '../catalogue/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { copyOf as editCopyOf } from '../work-levels-edit/messages.ts';
import { globalWorkHref } from '../work-page/route.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { readingLine, type IngredientQualifier } from './ingredient-line.ts';
import { copyOf } from './messages.ts';
import { RecipeAuthoringRecordedPage } from './recipe-authoring-recorded-page.tsx';

const authoring = authoringFixture as AnswerRecord;
const exchange = exchangeFixture as AnswerRecord;
const copy = copyOf('en');
const editCopy = editCopyOf('en');
const servedRegistry = exchange.personas.visitor.find((item) => item.label === 'frame-types')!
  .answer as TypeRegistry;

function recorded(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const sample = record.personas[persona].find((item) => item.label === label);
  if (!sample) throw new Error(`Missing ${record.row}/${persona}/${label}`);
  return sample;
}

type RecipeAnswer = {
  occurrences: {
    role: string;
    state: string;
    labels?: { value: string }[];
    qualifier?: IngredientQualifier & { instructionText?: { value: string } };
  }[];
};
type Named = { name: { value: string } };
type Titled = { title: string };
type Header = { id: string; title: { value: string } };

const authorDraft = recorded(authoring, 'owner', 'editor-recipe-draft').answer as RecipeAnswer;
const authorTitle = (recorded(authoring, 'owner', 'editor-resource-summary').answer as Named).name
  .value;
const authorHeader = recorded(authoring, 'owner', 'editor-work-header').answer as Header;
const exchangeRecipe = recorded(exchange, 'owner', 'editor-recipe').answer as RecipeAnswer;
const exchangeTitle = (recorded(exchange, 'owner', 'editor-resource-summary').answer as Named).name
  .value;
const exchangeHeader = recorded(exchange, 'owner', 'editor-work-header').answer as Header;
const exported = recorded(exchange, 'owner', 'schema-org-export');
const stale = recorded(exchange, 'owner', 'file-import-stale');
const staleTitle = (stale.answer as Titled).title;

const authorReads = [
  { label: 'editor-authority', state: 'populated' },
  { label: 'editor-work-header', state: 'populated' },
  { label: 'editor-resource-summary', state: 'populated' },
  { label: 'editor-metadata-empty', state: 'populated' },
  { label: 'editor-recipe-draft', state: 'populated' },
  { label: 'editor-notes-empty', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const visitFrame = [
  { label: 'frame-platform-access', state: 'populated' },
  { label: 'frame-types', state: 'populated' },
  { label: 'frame-official-zones', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const signedInFrame = [
  ...visitFrame,
  { label: 'frame-acting-contexts', state: 'populated' },
  { label: 'frame-agent-choices', state: 'populated' },
  { label: 'frame-session-agent', state: 'populated' },
  { label: 'frame-agent-profile', state: 'populated' },
  { label: 'frame-person-preferences', state: 'populated' },
  { label: 'frame-managed-realms', state: 'populated' },
  { label: 'frame-pinned-communities', state: 'populated' },
  { label: 'frame-space-communities', state: 'populated' },
  { label: 'frame-follow-inventory', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const exchangeReads = [
  ...signedInFrame,
  { label: 'editor-authority', state: 'populated' },
  { label: 'editor-work-header', state: 'populated' },
  { label: 'editor-resource-summary', state: 'populated' },
  { label: 'editor-metadata-empty', state: 'populated' },
  { label: 'editor-recipe', state: 'populated' },
  { label: 'editor-notes-empty', state: 'populated' },
  { label: 'schema-org-export', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

function linesOf(answer: RecipeAnswer): string[] {
  return answer.occurrences
    .filter((item) => item.role === 'ingredient' && item.state === 'active' && item.qualifier)
    .map((item) => readingLine(item.qualifier as IngredientQualifier));
}

function stepText(answer: RecipeAnswer): string[] {
  return answer.occurrences
    .filter((item) => item.role === 'step' && item.state === 'active')
    .map((item) => item.qualifier?.instructionText?.value ?? '');
}

async function expectRecipe(
  canvas: ReturnType<typeof within>,
  title: string,
  answer: RecipeAnswer,
  work: string,
) {
  await expect(canvas.findByRole('textbox', { name: copy.title })).resolves.toHaveValue(title);
  const ingredients = within(canvas.getByRole('region', { name: copy.ingredientsHeading }));
  for (const line of linesOf(answer))
    await expect(ingredients.findByText(line)).resolves.toBeVisible();
  const method = within(canvas.getByRole('region', { name: copy.methodHeading }));
  for (const [index, text] of stepText(answer).entries()) {
    await expect(
      method.getByRole('textbox', { name: copy.stepText({ number: String(index + 1) }) }),
    ).toHaveValue(text);
  }
  await expect(canvas.getByRole('link', { name: copy.backToRecipe })).toHaveAttribute(
    'href',
    localizedPath(globalWorkHref(work), 'en'),
  );
}

const meta = {
  title: 'Recipe editor/Recorded authoring',
  component: RecipeAuthoringRecordedPage,
  args: {
    record: authoring,
    persona: 'owner' as const,
    selections: authorReads,
    locale: 'en' as const,
    frame: false,
    registry: servedRegistry,
    mode: 'page' as const,
  },
  render: (args, { globals }) => (
    <RecipeAuthoringRecordedPage
      {...args}
      locale={(globals.locale as UiLocale | undefined) ?? args.locale}
    />
  ),
} satisfies Meta<typeof RecipeAuthoringRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function populatedAuthor({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expectRecipe(canvas, authorTitle, authorDraft, authorHeader.id);
  await expect(canvas.getByRole('textbox', { name: copy.stepText({ number: '3' }) })).toHaveValue(
    'Private draft note.',
  );
  await expect(canvas.queryByRole('alert')).toBeNull();
}

async function loadingAuthor({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.queryByRole('textbox', { name: copy.title })).toBeNull();
  await expect(canvas.queryByText(authorTitle)).toBeNull();
  await expect(canvas.queryByRole('alert')).toBeNull();
}

async function populatedExchange({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expectRecipe(canvas, exchangeTitle, exchangeRecipe, exchangeHeader.id);
  const revision = new URL(exported.path, 'https://recorded.invalid').searchParams
    .get('revision')!
    .slice(-36);
  const download = await canvas.findByRole('button', { name: copy.exportAction });
  await waitFor(() => expect(download).toBeEnabled());
  await userEvent.click(download);
  await expect(canvas.findByText(copy.exportedRevision({ revision }))).resolves.toBeVisible();
}

async function signInVisitor({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const header = recorded(exchange, 'visitor', 'editor-work-header').answer as Header;
  await expect(canvas.findByRole('heading', { name: editCopy.signInTitle })).resolves.toBeVisible();
  await expect(canvas.getByRole('link', { name: editCopy.backToWork })).toHaveAttribute(
    'href',
    localizedPath(globalWorkHref(header.id), 'en'),
  );
  await expect(canvas.queryByRole('textbox', { name: copy.title })).toBeNull();
  await expect(canvas.queryByRole('alert')).toBeNull();
}

async function noAuthorityStranger({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const header = recorded(exchange, 'stranger', 'editor-work-header').answer as Header;
  await expect(
    canvas.findByRole('heading', { name: editCopy.noAuthorityTitle }),
  ).resolves.toBeVisible();
  await expect(canvas.getByRole('link', { name: editCopy.backToWork })).toHaveAttribute(
    'href',
    localizedPath(globalWorkHref(header.id), 'en'),
  );
  await expect(canvas.queryByRole('textbox', { name: copy.title })).toBeNull();
}

async function loadingVisitor({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.queryByRole('heading', { name: editCopy.signInTitle })).toBeNull();
  await expect(canvas.queryByRole('alert')).toBeNull();
}

async function staleImport({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const input = await canvas.findByLabelText(copy.importAction, { selector: 'input' });
  await waitFor(() => expect(input).toBeEnabled());
  const file = new File([JSON.stringify(stale.body)], 'recipe.json', { type: 'application/json' });
  await userEvent.upload(input, file);
  await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(staleTitle);
}

const populatedAuthorStory = { play: populatedAuthor } satisfies Story;
const loadingAuthorStory = {
  args: {
    selections: [
      { label: 'editor-authority', state: 'loading' },
      { label: 'editor-work-header', state: 'populated' },
    ] as const,
  },
  play: loadingAuthor,
} satisfies Story;
const populatedExchangeStory = {
  args: { record: exchange, selections: exchangeReads, frame: true, registry: null },
  play: populatedExchange,
} satisfies Story;
const signInVisitorStory = {
  args: {
    record: exchange,
    persona: 'visitor' as const,
    frame: true,
    registry: null,
    selections: [...visitFrame, { label: 'editor-work-header', state: 'populated' }] as const,
  },
  play: signInVisitor,
} satisfies Story;
const noAuthorityStory = {
  args: {
    record: exchange,
    persona: 'stranger' as const,
    frame: true,
    registry: null,
    selections: [
      ...signedInFrame,
      { label: 'editor-authority', state: 'populated' },
      { label: 'editor-work-header', state: 'populated' },
    ] as const,
  },
  play: noAuthorityStranger,
} satisfies Story;
const loadingVisitorStory = {
  args: {
    record: exchange,
    persona: 'visitor' as const,
    frame: true,
    registry: null,
    selections: [{ label: 'frame-platform-access', state: 'loading' }] as const,
  },
  play: loadingVisitor,
} satisfies Story;
const staleStory = {
  args: {
    record: exchange,
    persona: 'owner' as const,
    frame: false,
    registry: null,
    mode: 'file-import' as const,
    selections: [{ label: 'file-import-stale', state: 'error' }] as const,
  },
  play: staleImport,
} satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

export const PopulatedOwnerPhone: Story = at(populatedAuthorStory, 'phone');
export const PopulatedOwnerDesktop: Story = at(populatedAuthorStory, 'desktop');
export const LoadingOwnerPhone: Story = at(loadingAuthorStory, 'phone');
export const LoadingOwnerDesktop: Story = at(loadingAuthorStory, 'desktop');
export const PopulatedExchangeOwnerPhone: Story = at(populatedExchangeStory, 'phone');
export const PopulatedExchangeOwnerDesktop: Story = at(populatedExchangeStory, 'desktop');
export const SignInVisitorPhone: Story = at(signInVisitorStory, 'phone');
export const SignInVisitorDesktop: Story = at(signInVisitorStory, 'desktop');
export const NoAuthorityStrangerPhone: Story = at(noAuthorityStory, 'phone');
export const NoAuthorityStrangerDesktop: Story = at(noAuthorityStory, 'desktop');
export const LoadingVisitorPhone: Story = at(loadingVisitorStory, 'phone');
export const LoadingVisitorDesktop: Story = at(loadingVisitorStory, 'desktop');
export const StaleImportOwnerPhone: Story = at(staleStory, 'phone');
export const StaleImportOwnerDesktop: Story = at(staleStory, 'desktop');
