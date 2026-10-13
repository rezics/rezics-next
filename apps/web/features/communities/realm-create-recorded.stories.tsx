import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import creation from '../../../../tests/qa/fixtures/outcomes/realm/create-a-realm.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { realmHref } from '../realm/route.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { communityText as words } from './messages.ts';
import { RealmCreateRecordedPage } from './realm-create-recorded-page.tsx';

const record = creation as AnswerRecord;

function recorded(persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample || !sample.answer || typeof sample.answer !== 'object') throw new Error(`Missing ${persona} sample ${label}`);
  return sample;
}

type Receipt = { realm: string; owner: string; realmRevision: string; spaceRevision: string };
type Header = { name: { value: string }; visibility: string; listing: string; admission: string };
type Problem = { title: string; code: string };
type CreationBody = { handle: string };

const strangerReceipt = recorded('stranger', 'creation-receipt');
const strangerHeader = recorded('stranger', 'created-realm-header');
const strangerAnswer = strangerReceipt.answer as Receipt;
const strangerNamed = strangerHeader.answer as Header;
const strangerHandle = (strangerReceipt.body as CreationBody).handle;
const visitorRefusal = recorded('visitor', 'creation-sign-in-required');
const visitorProblem = visitorRefusal.answer as Problem;

const populated = [
  { label: 'creation-receipt', state: 'populated' },
  { label: 'created-realm-header', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const loading = [{ label: 'creation-receipt', state: 'loading' }] as const satisfies readonly RecordedSelection[];
const refusal = [{ label: 'creation-sign-in-required', state: 'error' }] as const satisfies readonly RecordedSelection[];

const meta = {
  title: 'Communities/Recorded realm creation',
  component: RealmCreateRecordedPage,
  args: { record, persona: 'stranger' as const, selections: populated, locale: 'en' as const },
  parameters: { route: { pathname: '/en/r/new' } },
  render: (args, { globals }) => (
    <RealmCreateRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof RealmCreateRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function populatedPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const id = strangerAnswer.realm.slice(-36);
  await expect(canvas.findByRole('heading', { level: 1, name: words.createTitle.en })).resolves.toBeVisible();
  await expect(canvas.findByRole('heading', { level: 2, name: strangerNamed.name.value })).resolves.toBeVisible();
  await expect(canvas.getByRole('link', { name: strangerNamed.name.value })).toHaveAttribute('href', realmHref('en', id));
  await expect(canvas.getByText(strangerHandle)).toBeVisible();
  await expect(canvas.getByText(strangerAnswer.realm)).toBeVisible();
  await expect(canvas.getByText(strangerNamed.visibility)).toBeVisible();
  await expect(canvas.getByText(strangerNamed.listing)).toBeVisible();
  await expect(canvas.getByText(strangerNamed.admission)).toBeVisible();
  await expect(canvas.getByText(strangerAnswer.owner)).toBeVisible();
  await expect(canvas.getByText(strangerAnswer.realmRevision)).toBeVisible();
  await expect(canvas.getByText(strangerAnswer.spaceRevision)).toBeVisible();
  await expect(canvas.getByRole('link', { name: words.manage.en })).toHaveAttribute('href', localizedPath(`/manage/r/${id}`, 'en'));
  await expect(canvas.queryByRole('alert')).toBeNull();
}

async function refusalPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const alert = await canvas.findByRole('alert');
  await expect(alert).toHaveTextContent(visitorProblem.title);
  await expect(alert).toHaveTextContent(words.createFailed.en);
  await expect(canvas.getByRole('heading', { level: 1, name: words.createTitle.en })).toBeVisible();
  await expect(canvas.queryByRole('heading', { level: 2, name: strangerNamed.name.value })).toBeNull();
  await expect(canvas.queryByText(strangerAnswer.realm)).toBeNull();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(words.creating.en);
  await expect(canvas.getByRole('heading', { level: 1, name: words.createTitle.en })).toBeVisible();
  await expect(canvas.queryByText(strangerNamed.name.value)).toBeNull();
  await expect(canvas.queryByText(strangerAnswer.realm)).toBeNull();
  await expect(canvas.queryByRole('alert')).toBeNull();
}

const populatedStranger = { play: populatedPlay } satisfies Story;
const refusalVisitor = {
  args: { persona: 'visitor' as const, selections: refusal },
  play: refusalPlay,
} satisfies Story;
const loadingStranger = { args: { selections: loading }, play: loadingPlay } satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

export const PopulatedStrangerPhone: Story = at(populatedStranger, 'phone');
export const PopulatedStrangerDesktop: Story = at(populatedStranger, 'desktop');
export const RefusalVisitorPhone: Story = at(refusalVisitor, 'phone');
export const RefusalVisitorDesktop: Story = at(refusalVisitor, 'desktop');
export const LoadingStrangerPhone: Story = at(loadingStranger, 'phone');
export const LoadingStrangerDesktop: Story = at(loadingStranger, 'desktop');
